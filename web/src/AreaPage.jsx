import React, { useEffect, useRef, useState } from "react";
import maplibregl, { useMap, setLine, setMask, setMarkers } from "./map.js";

async function readJson(resp) {
  const text = await resp.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Server error ${resp.status}${text ? `: ${text}` : " (empty response)"}`);
  }
}

const CLICK_TOL_PX = 14;

export default function AreaPage({ areaToken, campaignToken }) {
  const containerRef = useRef(null);
  const map = useMap(containerRef);
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("click"); // 'click' | 'freehand'
  const [clickPts, setClickPts] = useState([]);
  const [drawnPts, setDrawnPts] = useState([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [routeEdit, setRouteEdit] = useState(null); // { id, points: [{x,y}] }
  const [hoverWp, setHoverWp] = useState(null);
  const fitted = useRef(false);
  const routeMarkers = useRef([]);
  const dragging = useRef(false);

  const load = async () => {
    const d = await fetch(`/a/${areaToken}/${campaignToken}`, { cache: "no-store" }).then((r) => r.json());
    if (d.error) { setError(d.error); return; }
    setData(d);
    document.title = `${d.area.name} - ${d.campaign.name}`;
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [areaToken, campaignToken]);

  // Reflect area changes made elsewhere: refetch when the window regains focus.
  useEffect(() => {
    const reload = () => { load().catch(() => {}); };
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaToken, campaignToken]);

  // Show only this area: dim everything outside it (no colour on the area itself).
  useEffect(() => {
    if (!map || !data?.area) return;
    setMask(map, "area-mask", data.area.polygon, 0.6);
    setLine(map, "area-outline", data.area.polygon.coordinates[0], { color: "#e5e7eb", width: 2 });
    if (fitted.current) return;
    fitted.current = true;

    const coords = data.area.polygon.coordinates[0];
    if (!coords || coords.length < 2) return;
    // fitBounds expects two corners ([[w,s],[e,n]]), NOT the ring itself.
    const xs = coords.map((p) => p[0]);
    const ys = coords.map((p) => p[1]);
    const bounds = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];

    // Fit only once the container has a real size; otherwise fitBounds can
    // produce an absurd result (the map appears zoomed all the way out).
    let tries = 0;
    const fit = () => {
      const el = map.getContainer();
      if ((el.clientWidth === 0 || el.clientHeight === 0) && tries++ < 120) { requestAnimationFrame(fit); return; }
      map.resize();
      try { map.fitBounds(bounds, { padding: 60, maxZoom: 16 }); } catch { /* ignore */ }
    };
    requestAnimationFrame(fit);
  }, [map, data]);

  // Existing routes (in the area's colour; the one being edited is drawn as the draft)
  useEffect(() => {
    if (!map || !data) return;
    const color = data.area?.color || "#a78bfa";
    (data.routes || []).forEach((r) => {
      if (routeEdit?.id === r.id) { setLine(map, `route-${r.id}`, [], {}); return; }
      setLine(map, `route-${r.id}`, r.path.coordinates, { color, width: 3, opacity: 0.95 });
    });
  }, [map, data, routeEdit]);

  // Draft (new route or route being edited)
  useEffect(() => {
    if (!map) return;
    if (mode === "route-edit" && routeEdit) {
      const coords = routeEdit.points.map((p) => [p.x, p.y]);
      setLine(map, "draft", coords.length >= 2 ? coords : [], { color: "#38bdf8", width: 3 });
    } else if (mode === "click") {
      setLine(map, "draft", clickPts.length >= 2 ? clickPts : [], { color: "#f59e0b", width: 3 });
      setMarkers(map, clickPts, { color: "#f59e0b", size: "8px" });
    } else {
      setLine(map, "draft", drawnPts.length >= 2 ? drawnPts : []);
    }
  }, [map, mode, clickPts, drawnPts, routeEdit]);

  // Draggable numbered route waypoint markers (snapped to roads on drop).
  useEffect(() => {
    if (!map || mode !== "route-edit" || !routeEdit) {
      routeMarkers.current.forEach((m) => m.marker.remove());
      routeMarkers.current = [];
      return;
    }
    const pts = routeEdit.points;
    if (routeMarkers.current.length !== pts.length) {
      routeMarkers.current.forEach((m) => m.marker.remove());
      routeMarkers.current = pts.map((p, i) => {
        const el = document.createElement("div");
        el.textContent = String(i + 1);
        Object.assign(el.style, {
          width: "20px", height: "20px", borderRadius: "50%",
          background: "#38bdf8", color: "#012",
          fontSize: "11px", fontWeight: "700", lineHeight: "20px", textAlign: "center",
          border: "2px solid #000", boxShadow: "0 0 6px rgba(0,0,0,.6)",
          cursor: "grab", userSelect: "none",
        });
        const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([p.x, p.y]).addTo(map);
        marker.on("dragstart", () => { dragging.current = true; });
        marker.on("dragend", async () => {
          const ll = marker.getLngLat();
          const snapped = await snapCoord(ll.lng, ll.lat);
          marker.setLngLat([snapped.x, snapped.y]);
          setRouteEdit((e) => {
            const arr = e.points.slice();
            arr[i] = { x: snapped.x, y: snapped.y };
            return { ...e, points: arr };
          });
          dragging.current = false;
        });
        return { marker, el };
      });
    }
  }, [map, mode, routeEdit?.points.length]);

  // Highlight hovered waypoint from the list.
  useEffect(() => {
    routeMarkers.current.forEach(({ el }, i) => {
      const on = i === hoverWp;
      el.style.background = on ? "#ef4444" : "#38bdf8";
      el.style.color = on ? "#fff" : "#012";
      el.style.zIndex = on ? "10" : "1";
      el.style.boxShadow = on ? "0 0 0 3px rgba(239,68,68,.55), 0 0 10px rgba(0,0,0,.7)" : "0 0 6px rgba(0,0,0,.6)";
    });
  }, [hoverWp, routeEdit?.points.length, mode]);

  const snapCoord = async (lon, lat) => {
    const slug = data?.city?.slug;
    if (!slug) return { x: lon, y: lat };
    try {
      const r = await fetch(`/api/cities/${slug}/snap?lon=${lon}&lat=${lat}`);
      const j = await r.json();
      if (Number.isFinite(j.lon) && Number.isFinite(j.lat)) return { x: j.lon, y: j.lat };
    } catch { /* ignore */ }
    return { x: lon, y: lat };
  };

  const onMapClick = async (e) => {
    const raw = { x: e.lngLat.lng, y: e.lngLat.lat };
    if (mode === "route-edit") {
      if (dragging.current || !routeEdit) return;
      const p = await snapCoord(raw.x, raw.y);
      setRouteEdit((d) => (d ? { ...d, points: insertNearestEdge(d.points, p) } : d));
      return;
    }
    if (mode !== "click") return;
    const p = await snapCoord(raw.x, raw.y);
    setClickPts((prev) => [...prev, [p.x, p.y]]);
  };
  useEffect(() => {
    if (!map || (mode !== "click" && mode !== "route-edit")) return;
    map.on("click", onMapClick);
    return () => map.off("click", onMapClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mode, data, routeEdit]);

  // Freehand drawing via pointer events
  useEffect(() => {
    if (!map || mode !== "freehand") return;
    const onDown = (e) => {
      setIsDrawing(true);
      setDrawnPts([[e.lngLat.lng, e.lngLat.lat]]);
      e.originalEvent?.preventDefault?.();
    };
    const onMove = (e) => {
      if (!isDrawing) return;
      setDrawnPts((p) => (p && [...p, [e.lngLat.lng, e.lngLat.lat]]));
    };
    const onUp = () => setIsDrawing(false);
    map.on("mousedown", onDown);
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    return () => {
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mode, isDrawing]);

  function insertNearestEdge(points, p) {
    if (points.length < 2) return [...points, { ...p }];
    let bestI = 0, bestD = Infinity, bestProj = { x: p.x, y: p.y };
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const r = projectOnSeg(p, a, b);
      const d = Math.hypot(r.x - p.x, r.y - p.y);
      if (d < bestD) { bestD = d; bestI = i; bestProj = r; }
    }
    const out = points.slice();
    out.splice(bestI + 1, 0, bestProj);
    return out;
  }
  function projectOnSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 === 0) return { ...a };
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    return { x: a.x + t * abx, y: a.y + t * aby };
  }

  const routePoints = (r) => {
    const src = r.waypoints?.coordinates || r.drawn?.coordinates || r.path?.coordinates || [];
    return src.map((c) => ({ x: c[0], y: c[1] }));
  };
  const startRouteEdit = (r) => {
    setClickPts([]); setDrawnPts([]); setError(null);
    setMode("route-edit");
    setRouteEdit({ id: r.id, points: routePoints(r) });
  };
  const cancelRouteEdit = () => { setRouteEdit(null); setMode("click"); setHoverWp(null); };
  const deleteRouteWaypoint = (i) => {
    setRouteEdit((d) => {
      if (!d || d.points.length <= 2) return d;
      const arr = d.points.slice();
      arr.splice(i, 1);
      return { ...d, points: arr };
    });
  };
  const saveRouteEdit = async () => {
    if (!routeEdit || routeEdit.points.length < 2) return setError("A route needs at least 2 waypoints.");
    setBusy(true); setError(null);
    try {
      const resp = await fetch(`/api/routes/${routeEdit.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: routeEdit.points.map((p) => [p.x, p.y]) }),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      await load();
      cancelRouteEdit();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const deleteRoute = async (r) => {
    if (!window.confirm("Delete this route?")) return;
    try {
      const resp = await fetch(`/api/routes/${r.id}`, { method: "DELETE" });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      if (routeEdit?.id === r.id) cancelRouteEdit();
      await load();
    } catch (e) { setError(e.message); }
  };

  const submit = async () => {
    let body = null;
    if (mode === "click" && clickPts.length >= 2) body = { campaign_id: data.campaign.id, waypoints: clickPts };
    else if (mode === "freehand" && drawnPts.length >= 2) body = { campaign_id: data.campaign.id, drawn: drawnPts };
    else { setError(`Draw ${mode === "click" ? "at least 2 waypoints" : "a line on the map"} first.`); return; }
    setBusy(true); setError(null);
    try {
      const resp = await fetch(`/api/areas/${data.area.id}/routes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      setData((d) => ({ ...d, routes: [json, ...(d.routes || [])] }));
      setClickPts([]); setDrawnPts([]);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    });
  };

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {!data && !error && (
        <div style={{ position: "absolute", inset: 0, background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
          Loading…
        </div>
      )}

      <div style={{ position: "absolute", top: 12, left: 12, width: 310, maxHeight: "calc(100% - 24px)", overflow: "auto", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 14, zIndex: 10 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{data?.area?.name}{data?.campaign?.name ? ` - ${data.campaign.name}` : ""}</h2>
          <span className="hint">{data?.city?.name}</span>
        </div>

        {!routeEdit ? (
          <>
            <p className="hint">Record routes you have walked in this area.</p>
            <div className="row" style={{ margin: "10px 0" }}>
              <button className={mode === "click" ? "" : "ghost"} onClick={() => setMode("click")}>Click points</button>
              <button className={mode === "freehand" ? "" : "ghost"} onClick={() => setMode("freehand")}>Draw line</button>
            </div>
            <div className="col">
              {mode === "click"
                ? <span className="hint">{clickPts.length} waypoints. Click points on the map (they snap to roads), then Save route.</span>
                : <span className="hint">Hold & drag on the map along your path, then Save route.</span>}
              <div className="row">
                <button className="grow" onClick={submit} disabled={busy}>{busy ? "Routing…" : "Save route"}</button>
                <button className="ghost" onClick={() => { setClickPts([]); setDrawnPts([]); }}>Clear</button>
              </div>
              <button className="ghost" onClick={copyLink}>{linkCopied ? "Copied!" : "Copy share link"}</button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">Editing route #{routeEdit.id}.</p>
            <span className="hint">Waypoints ({routeEdit.points.length}) — drag on the map, click to add, or delete:</span>
            <div style={{ maxHeight: 160, overflow: "auto", margin: "4px 0" }}>
              {routeEdit.points.map((p, i) => (
                <div
                  key={i}
                  className="row"
                  onMouseEnter={() => setHoverWp(i)}
                  onMouseLeave={() => setHoverWp(null)}
                  style={{
                    justifyContent: "space-between", fontSize: 12, padding: "2px 4px", borderRadius: 4,
                    background: hoverWp === i ? "rgba(239,68,68,0.25)" : "transparent",
                  }}
                >
                  <span className="grow">#{i + 1} {p.x.toFixed(5)}, {p.y.toFixed(5)}</span>
                  <button className="ghost" disabled={routeEdit.points.length <= 2} onClick={() => deleteRouteWaypoint(i)}>Delete</button>
                </div>
              ))}
            </div>
            <div className="row">
              <button className="grow" onClick={saveRouteEdit} disabled={busy || routeEdit.points.length < 2}>
                {busy ? "Routing…" : "Save route"}
              </button>
              <button className="ghost" onClick={cancelRouteEdit}>Cancel</button>
            </div>
          </>
        )}

        <hr style={{ borderColor: "var(--border)", margin: "12px 0" }} />
        <span className="hint">Saved routes ({data?.routes?.length || 0})</span>
        <div style={{ maxHeight: 180, overflow: "auto", marginTop: 6 }}>
          {data?.routes?.map((r, i) => (
            <div key={r.id || i} className="row" style={{ justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
              <span className="grow">#{i + 1} · {r.distance_m ? `${Math.round(r.distance_m)} m` : ""}</span>
              <button className="ghost" onClick={() => startRouteEdit(r)} disabled={!!routeEdit}>Edit</button>
              <button className="ghost" onClick={() => deleteRoute(r)} disabled={!!routeEdit}>Del</button>
            </div>
          ))}
          {(!data?.routes || data.routes.length === 0) && <span className="hint">No routes yet.</span>}
        </div>

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </div>
  );
}
