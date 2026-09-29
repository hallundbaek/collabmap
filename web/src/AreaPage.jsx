import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { useMap, setLine, setFill, setMask, setMarkers } from "./map.js";
import { routeOpacity, routeDate } from "./routeFade.js";

async function readJson(resp) {
  const text = await resp.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Server error ${resp.status}${text ? `: ${text}` : " (empty response)"}`);
  }
}

export default function AreaPage({ areaToken, campaignToken }) {
  const containerRef = useRef(null);
  const map = useMap(containerRef);
  const [data, setData] = useState(null);
  const [mode, setMode] = useState(null); // 'add' | null
  const [clickPts, setClickPts] = useState([]); // [[x,y], ...]
  const [routesOpen, setRoutesOpen] = useState(false);
  const [highlightId, setHighlightId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [routeEdit, setRouteEdit] = useState(null); // { id, points: [{x,y}] }
  const [hoverWp, setHoverWp] = useState(null);
  const fitted = useRef(false);
  const routeMarkers = useRef([]);
  const dragging = useRef(false);
  const drawnRouteIds = useRef(new Set());
  const lastData = useRef(null);

  const url = `/a/${areaToken}/${campaignToken}`;
  const applyData = (d) => {
    lastData.current = JSON.stringify(d);
    setData(d);
    document.title = `${d.area.name} - ${d.campaign.name}`;
  };
  const load = async () => {
    const d = await fetch(url, { cache: "no-store" }).then((r) => r.json());
    if (d.error) { setError(d.error); return; }
    applyData(d);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [areaToken, campaignToken]);

  // Reflect area changes made elsewhere when the window regains focus — but only
  // if the data actually changed (avoids the mask/routes flashing).
  useEffect(() => {
    const reload = async () => {
      if (document.hidden) return;
      const d = await fetch(url, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
      if (!d || d.error) return;
      if (JSON.stringify(d) === lastData.current) return;
      applyData(d);
    };
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaToken, campaignToken]);

  // Show only this area: dim everything outside it (no colour on the area itself).
  // Other areas (and their routes) are drawn *under* the mask, so they stay
  // visible but darkened. Keyed on content so route-only changes don't redraw.
  const areaPolyKey = useMemo(() => (data?.area ? JSON.stringify(data.area.polygon) : ""), [data]);
  const othersKey = useMemo(() => JSON.stringify(data?.others || []), [data]);
  useEffect(() => {
    if (!map || !data?.area) return;

    // Clear previously drawn other-area layers before redrawing.
    const layerIds = map.getStyle().layers
      .map((l) => l.id)
      .filter((id) => id.startsWith("other-") || id.startsWith("otherroute-"));
    for (const id of layerIds) map.removeLayer(id);
    const sourceIds = Object.keys(map.getStyle().sources)
      .filter((id) => id.startsWith("other-") || id.startsWith("otherroute-"));
    for (const id of sourceIds) map.removeSource(id);

    // Other areas' fills go under the mask (dimmed)…
    for (const o of data.others || []) {
      setFill(map, `other-${o.id}`, o.polygon, { fill: o.color || "#64748b", border: o.color || "#64748b", opacity: 0.3, width: 1 });
    }

    setMask(map, "area-mask", data.area.polygon, 0.6);
    setLine(map, "area-outline", data.area.polygon.coordinates[0], { color: "#e5e7eb", width: 2 });

    // …but their routes are drawn over the mask so they stay clearly visible.
    for (const o of data.others || []) {
      (o.routes || []).forEach((p, i) => {
        const op = routeOpacity(p.created_at);
        setLine(map, `otherroute-${o.id}-${i}`, op > 0 ? p.path.coordinates : [], { color: o.color || "#94a3b8", width: 3, opacity: op });
      });
    }

    if (fitted.current) return;
    fitted.current = true;

    const coords = data.area.polygon.coordinates[0];
    if (!coords || coords.length < 2) return;
    const xs = coords.map((p) => p[0]);
    const ys = coords.map((p) => p[1]);
    const bounds = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
    let tries = 0;
    const fit = () => {
      const el = map.getContainer();
      if ((el.clientWidth === 0 || el.clientHeight === 0) && tries++ < 120) { requestAnimationFrame(fit); return; }
      map.resize();
      try { map.fitBounds(bounds, { padding: 60, maxZoom: 16 }); } catch { /* ignore */ }
    };
    requestAnimationFrame(fit);
  }, [map, areaPolyKey, othersKey]);

  // Routes: draw in the area's colour, and remove deleted ones.
  // (Highlighting is a separate layer so hovering doesn't re-add every route.)
  useEffect(() => {
    if (!map || !data) return;
    const color = data.area?.color || "#a78bfa";
    const current = new Set((data.routes || []).map((r) => r.id));
    for (const id of drawnRouteIds.current) {
      if (!current.has(id)) {
        const src = `route-${id}`;
        if (map.getLayer(src + "-line")) map.removeLayer(src + "-line");
        if (map.getSource(src)) map.removeSource(src);
      }
    }
    drawnRouteIds.current = current;
    (data.routes || []).forEach((r) => {
      if (routeEdit?.id === r.id) { setLine(map, `route-${r.id}`, [], {}); return; }
      const op = routeOpacity(r.created_at);
      setLine(map, `route-${r.id}`, op > 0 ? r.path.coordinates : [], { color, width: 3, opacity: op });
    });
  }, [map, data, routeEdit]);

  // Highlight layer (one route, drawn on top) — updated without touching the rest.
  useEffect(() => {
    if (!map) return;
    const src = "route-highlight";
    if (map.getLayer(src + "-line")) map.removeLayer(src + "-line");
    if (map.getSource(src)) map.removeSource(src);
    const r = (data?.routes || []).find((x) => x.id === highlightId);
    if (!r?.path?.coordinates) return;
    setLine(map, src, r.path.coordinates, { color: "#ffd166", width: 6, opacity: 1 });
  }, [map, data, highlightId]);

  // Draft (new route waypoints or the route being edited)
  useEffect(() => {
    if (!map) return;
    if (routeEdit) {
      const coords = routeEdit.points.map((p) => [p.x, p.y]);
      setLine(map, "draft", coords.length >= 2 ? coords : [], { color: "#38bdf8", width: 3 });
      setMarkers(map, [], {});
    } else if (mode === "add") {
      setLine(map, "draft", clickPts.length >= 2 ? clickPts : [], { color: "#f59e0b", width: 3 });
      setMarkers(map, clickPts, { color: "#f59e0b", size: "8px" });
    } else {
      setLine(map, "draft", [], {});
      setMarkers(map, [], {});
    }
  }, [map, mode, clickPts, routeEdit]);

  // Draggable numbered route waypoint markers (snapped to roads on drop).
  useEffect(() => {
    if (!map || !routeEdit) {
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
  }, [map, routeEdit?.points.length]);

  // Highlight hovered waypoint from the route-edit list.
  useEffect(() => {
    routeMarkers.current.forEach(({ el }, i) => {
      const on = i === hoverWp;
      el.style.background = on ? "#ef4444" : "#38bdf8";
      el.style.color = on ? "#fff" : "#012";
      el.style.zIndex = on ? "10" : "1";
      el.style.boxShadow = on ? "0 0 0 3px rgba(239,68,68,.55), 0 0 10px rgba(0,0,0,.7)" : "0 0 6px rgba(0,0,0,.6)";
    });
  }, [hoverWp, routeEdit?.points.length]);

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
    if (routeEdit) {
      if (dragging.current) return;
      const p = await snapCoord(raw.x, raw.y);
      setRouteEdit((d) => (d ? { ...d, points: insertNearestEdge(d.points, p) } : d));
      return;
    }
    if (mode !== "add") return;
    const p = await snapCoord(raw.x, raw.y);
    setClickPts((prev) => [...prev, [p.x, p.y]]);
  };
  useEffect(() => {
    if (!map || (!routeEdit && mode !== "add")) return;
    map.on("click", onMapClick);
    return () => map.off("click", onMapClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mode, data, routeEdit]);

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

  // ---- Add a route ----
  const startAdd = () => { setRouteEdit(null); setRoutesOpen(false); setHighlightId(null); setClickPts([]); setError(null); setMode("add"); };
  const cancelAdd = () => { setMode(null); setClickPts([]); };
  const undoAdd = () => setClickPts((p) => p.slice(0, -1));
  const confirmAdd = async () => {
    if (clickPts.length < 2) return setError("Place at least 2 waypoints on the map.");
    setBusy(true); setError(null);
    try {
      const resp = await fetch(`/api/areas/${data.area.id}/routes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: data.campaign.id, waypoints: clickPts }),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      setData((d) => { const next = { ...d, routes: [json, ...(d.routes || [])] }; lastData.current = JSON.stringify(next); return next; });
      setClickPts([]); setMode(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // ---- Edit / delete routes ----
  const routePoints = (r) => {
    const src = r.waypoints?.coordinates || r.drawn?.coordinates || r.path?.coordinates || [];
    return src.map((c) => ({ x: c[0], y: c[1] }));
  };
  const startRouteEdit = (r) => {
    setClickPts([]); setMode(null); setError(null);
    setRouteEdit({ id: r.id, points: routePoints(r) });
  };
  const cancelRouteEdit = () => { setRouteEdit(null); setHoverWp(null); };
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
      setData((d) => { const next = { ...d, routes: (d.routes || []).map((r) => (r.id === json.id ? json : r)) }; lastData.current = JSON.stringify(next); return next; });
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
      if (highlightId === r.id) setHighlightId(null);
      setData((d) => { const next = { ...d, routes: (d.routes || []).filter((x) => x.id !== r.id) }; lastData.current = JSON.stringify(next); return next; });
    } catch (e) { setError(e.message); }
  };

  const routes = data?.routes || [];
  const routesReversed = [...routes].reverse(); // oldest first → latest has highest number

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {!data && !error && (
        <div style={{ position: "absolute", inset: 0, background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
          Loading…
        </div>
      )}

      <div style={{ position: "absolute", top: 12, left: 12, width: 300, maxHeight: "calc(100% - 24px)", overflow: "auto", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 14, zIndex: 10 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{data?.area?.name}{data?.campaign?.name ? ` - ${data.campaign.name}` : ""}</h2>
          <span className="hint">{data?.city?.name}</span>
        </div>

        {mode === "add" ? (
          <div className="col" style={{ marginTop: 8 }}>
            <span className="hint">{clickPts.length} waypoint(s)</span>
            <div className="row">
              <button className="grow" onClick={confirmAdd} disabled={busy || clickPts.length < 2}>{busy ? "Saving…" : "Confirm"}</button>
              <button className="ghost" onClick={undoAdd} disabled={!clickPts.length}>Undo</button>
              <button className="ghost" onClick={cancelAdd}>Cancel</button>
            </div>
          </div>
        ) : routeEdit ? (
          <div className="col" style={{ marginTop: 8 }}>
            <p className="hint">Editing route. Drag waypoints, click to add, or delete:</p>
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
              <button className="grow" onClick={saveRouteEdit} disabled={busy || routeEdit.points.length < 2}>{busy ? "Saving…" : "Save route"}</button>
              <button className="ghost" onClick={cancelRouteEdit}>Cancel</button>
            </div>
          </div>
        ) : routesOpen ? (
          <div className="col" style={{ marginTop: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="hint">Routes ({routes.length})</span>
              <button className="ghost" onClick={() => { setRoutesOpen(false); setHighlightId(null); }}>Back</button>
            </div>
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              {routesReversed.map((r, i) => (
                <div
                  key={r.id}
                  className="row"
                  onMouseEnter={() => setHighlightId(r.id)}
                  onMouseLeave={() => setHighlightId(null)}
                  onClick={() => setHighlightId(r.id)}
                  style={{
                    justifyContent: "space-between", fontSize: 12, padding: "3px 4px", borderRadius: 4, cursor: "pointer",
                    background: highlightId === r.id ? "rgba(255,209,102,0.25)" : "transparent",
                  }}
                >
                  <span style={{ width: 28 }}>#{i + 1}</span>
                  <span className="grow">{r.distance_m ? `${Math.round(r.distance_m)} m` : ""}</span>
                  <span className="hint" style={{ whiteSpace: "nowrap" }}>{routeDate(r.created_at).toLocaleDateString()}</span>
                  <button className="ghost" onClick={(e) => { e.stopPropagation(); startRouteEdit(r); }}>Edit</button>
                  <button className="ghost" onClick={(e) => { e.stopPropagation(); deleteRoute(r); }}>Del</button>
                </div>
              ))}
              {routes.length === 0 && <span className="hint">No routes yet.</span>}
            </div>
          </div>
        ) : (
          <div className="col" style={{ marginTop: 8 }}>
            <div className="row">
              <button className="grow" onClick={startAdd}>Add route</button>
              <button className="grow" onClick={() => setRoutesOpen(true)}>See routes</button>
            </div>
          </div>
        )}

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </div>
  );
}
