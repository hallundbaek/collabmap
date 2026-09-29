import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { useMap, setLine, setFill, setMarkers, setLabels, drawRoutes } from "./map.js";
import { routeOpacity } from "./routeFade.js";

const CLICK_TOL_PX = 14;
const DEFAULT_COLOR = "#22c55e";

// Two areas share an edge when they both have the same two waypoints consecutive.
function areaEdges(a) {
  const ids = (a.outline || []).map((w) => w.id);
  const set = new Set();
  for (let i = 0; i < ids.length; i++) {
    const u = ids[i], v = ids[(i + 1) % ids.length];
    set.add(u < v ? `${u}-${v}` : `${v}-${u}`);
  }
  return set;
}
function sharesEdge(a, b) {
  const ea = areaEdges(a);
  const ids = (b.outline || []).map((w) => w.id);
  for (let i = 0; i < ids.length; i++) {
    const u = ids[i], v = ids[(i + 1) % ids.length];
    if (ea.has(u < v ? `${u}-${v}` : `${v}-${u}`)) return true;
  }
  return false;
}

async function readJson(resp) {
  const text = await resp.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Server error ${resp.status}${text ? `: ${text}` : " (empty response)"}`);
  }
}

// Fetch a list endpoint, tolerating a non-array/error response.
async function fetchArray(url, headers) {
  try {
    const data = await fetch(url, { headers }).then((r) => r.json());
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export default function Builder({ token }) {
  const containerRef = useRef(null);
  const map = useMap(containerRef);
  const [cities, setCities] = useState([]);
  const [citySlug, setCitySlug] = useState(null);
  const [areas, setAreas] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [newCampaign, setNewCampaign] = useState("");
  const [linksFor, setLinksFor] = useState(null); // campaign id whose links modal is open
  const [active, setActive] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);

  const authHeaders = useMemo(() => ({ "x-admin-token": token }), [token]);
  const apiFetch = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders } });

  // Points are {id?, x, y}: id present when it references an existing (shared) waypoint.
  const [mode, setMode] = useState(null);
  const [create, setCreate] = useState({ name: "", points: [], closed: false });
  const [edit, setEdit] = useState(null); // { id, name, points }
  const [divide, setDivide] = useState(null); // { id, name, points, name1, name2 }
  const [wpOverrides, setWpOverrides] = useState({}); // waypoint id -> {x,y} (unsaved, live preview)
  const [options, setOptions] = useState(null); // { id, name, color } area options modal
  const [hoverWp, setHoverWp] = useState(null); // index of hovered waypoint in edit list
  const [copiedId, setCopiedId] = useState(null);

  const editMarkers = useRef([]);
  const dragging = useRef(false);
  const drawnAreaIds = useRef(new Set());
  const campRef = useRef(null);
  const editRef = useRef(null);
  useEffect(() => { campRef.current = selectedCampaignId; }, [selectedCampaignId]);
  useEffect(() => { editRef.current = edit; }, [edit]);

  const existingWps = useMemo(() => {
    const m = new Map();
    for (const a of areas) for (const w of a.outline || []) m.set(w.id, { id: w.id, x: w.x, y: w.y });
    return [...m.values()];
  }, [areas]);

  const loadAreas = async () => {
    if (!citySlug) return;
    setAreas(await fetchArray(`/api/cities/${citySlug}/areas`, authHeaders));
  };
  const loadCampaigns = async (preferId) => {
    if (!citySlug) return null;
    const list = await fetchArray(`/api/cities/${citySlug}/campaigns`, authHeaders);
    setCampaigns(list);
    const wanted = preferId !== undefined ? preferId : campRef.current;
    const cid = list.some((c) => c.id === wanted) ? wanted : (list[0]?.id ?? null);
    setSelectedCampaignId(cid);
    return cid;
  };
  const loadRoutes = async (cid) => {
    if (!citySlug || !cid) { setRoutes([]); return; }
    setRoutes(await fetchArray(`/api/cities/${citySlug}/routes?campaign_id=${cid}`, authHeaders));
  };
  const refresh = async () => {
    if (!citySlug) return;
    await loadAreas();
    const cid = await loadCampaigns();
    await loadRoutes(cid);
  };

  useEffect(() => {
    apiFetch("/api/cities").then(async (r) => {
      if (r.status === 401) { setTokenInvalid(true); return; }
      const list = await r.json();
      setCities(list);
      if (list[0]) {
        setCitySlug(list[0].slug);
        map?.flyTo({ center: list[0].center || [12.568, 55.676], zoom: list[0].initial_zoom || 12 });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!citySlug) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citySlug]);

  // Reload the map's routes whenever the selected campaign changes.
  useEffect(() => {
    loadRoutes(selectedCampaignId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citySlug, selectedCampaignId]);

  const selectCity = (slug) => {
    setCitySlug(slug);
    reset();
    const c = cities.find((x) => x.slug === slug);
    map?.flyTo({ center: c.center || [12.568, 55.676], zoom: c.initial_zoom || 12 });
  };

  const reset = () => {
    setActive(null); setMode(null);
    setCreate({ name: "", points: [], closed: false });
    setEdit(null); setDivide(null); setOptions(null); setHoverWp(null); setError(null);
    setWpOverrides({});
  };

  // ---- Areas: fill, border, clickable name label ----
  useEffect(() => {
    if (!map) return;
    // Remove layers/sources for areas that no longer exist (deleted or divided).
    const current = new Set(areas.map((a) => a.id));
    for (const id of drawnAreaIds.current) {
      if (!current.has(id)) {
        const src = "area-" + id;
        if (map.getLayer(src + "-fill")) map.removeLayer(src + "-fill");
        if (map.getLayer(src + "-border")) map.removeLayer(src + "-border");
        if (map.getSource(src)) map.removeSource(src);
      }
    }
    drawnAreaIds.current = current;
    for (const a of areas) {
      const color = a.color || DEFAULT_COLOR;
      // Live preview: use unsaved waypoint positions; the area being edited is
      // drawn from its draft points.
      let ring;
      if (mode === "edit" && edit && a.id === edit.id) {
        ring = edit.points.map((p) => [p.x, p.y]);
      } else {
        ring = (a.outline || []).map((w) => {
          const o = wpOverrides[w.id];
          return [o ? o.x : w.x, o ? o.y : w.y];
        });
      }
      const polygon = ring.length >= 3
        ? { type: "Polygon", coordinates: [[...ring, ring[0]]] }
        : a.polygon;
      setFill(map, "area-" + a.id, polygon, {
        fill: color,
        border: color,
        opacity: a.id === active || (mode === "edit" && edit && a.id === edit.id) ? 0.35 : 0.16,
        width: a.id === active || (mode === "edit" && edit && a.id === edit.id) ? 3 : 2,
      });
    }
    // Keep the routes layer above the (re-added) area fills.
    if (map.getLayer("aroutes-line")) map.moveLayer("aroutes-line");
  }, [map, areas, active, mode, edit, wpOverrides]);

  // ---- Area name labels + waypoint dots (independent of selection) ----
  useEffect(() => {
    if (!map) return;
    setLabels(
      map,
      "area-labels",
      areas.map((a) => ({ id: a.id, name: a.name, color: a.color || DEFAULT_COLOR, center: centroid(a.polygon.coordinates) })),
      {
        onEdit: (id) => startEditById(id),
        onOptions: (id) => openOptions(id),
        editingId: mode === "edit" ? edit?.id : null,
        onSave: () => saveEdit(),
        onCancel: () => reset(),
      }
    );
    setMarkers(map, existingWps.map((w) => [w.x, w.y]), { group: "existing", color: "#cbd5e1", size: "6px" });
  }, [map, areas, existingWps, mode, edit?.id]);

  // ---- Recorded routes, drawn in their area's colour (single layer) ----
  useEffect(() => {
    if (!map) return;
    const colorByArea = new Map(areas.map((a) => [a.id, a.color || DEFAULT_COLOR]));
    const features = (Array.isArray(routes) ? routes : [])
      .filter((r) => r.path?.coordinates)
      .map((r) => ({
        type: "Feature",
        properties: { color: colorByArea.get(r.area_id) || "#64748b", opacity: routeOpacity(r.created_at) },
        geometry: r.path,
      }));
    drawRoutes(map, "aroutes", features, { width: 5, opacity: 0.9 });
  }, [map, areas, routes]);

  function centroid(rings) {
    const ring = (rings?.[0] || []).slice();
    if (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    let s = [0, 0];
    for (const p of ring) { s[0] += p[0]; s[1] += p[1]; }
    return ring.length ? [s[0] / ring.length, s[1] / ring.length] : [0, 0];
  }

  // ---- Draft rendering ----
  const draftCoords = () => {
    if (mode === "create") return create.points.map((p) => [p.x, p.y]);
    if (mode === "edit") return edit?.points.map((p) => [p.x, p.y]) || [];
    if (mode === "divide") return divide?.points.map((p) => [p.x, p.y]) || [];
    return [];
  };
  const draftClosed = () => (mode === "create" ? create.closed : false);

  useEffect(() => {
    if (!map) return;
    const coords = draftCoords();
    setLine(map, "draft", coords, { color: "#f59e0b", width: 3 });
    if (coords.length >= 3 && draftClosed()) {
      setFill(map, "draft-fill", { type: "Polygon", coordinates: [[...coords, coords[0]]] }, { fill: "#f59e0b", border: "#f59e0b", opacity: 0.15 });
    } else {
      const src = "draft-fill";
      if (map.getSource(src)) { map.removeLayer(src + "-fill"); map.removeLayer(src + "-border"); map.removeSource(src); }
    }
    if (mode !== "edit") {
      setMarkers(map, coords, { group: "draft", color: "#f59e0b", size: "8px" });
    }
  }, [map, mode, create, edit, divide]);

  // ---- Edit draggable markers (persistent; numbered; snap to roads on drop) ----
  useEffect(() => {
    if (!map || mode !== "edit" || !edit) {
      editMarkers.current.forEach((m) => m.marker.remove());
      editMarkers.current = [];
      return;
    }
    const pts = edit.points;
    if (editMarkers.current.length !== pts.length) {
      editMarkers.current.forEach((m) => m.marker.remove());
      editMarkers.current = pts.map((p, i) => {
        const el = document.createElement("div");
        el.textContent = String(i + 1);
        Object.assign(el.style, {
          width: "20px", height: "20px", borderRadius: "50%",
          background: "#f59e0b", color: "#111",
          fontSize: "11px", fontWeight: "700", lineHeight: "20px", textAlign: "center",
          border: "2px solid #000", boxShadow: "0 0 6px rgba(0,0,0,.6)",
          cursor: "grab", userSelect: "none",
        });
        const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([p.x, p.y]).addTo(map);
        marker.on("dragstart", () => { dragging.current = true; });
        marker.on("drag", () => {
          // Live preview (unsnapped) so the area and its neighbours update as you drag.
          const ll = marker.getLngLat();
          setEdit((e) => {
            const arr = e.points.slice();
            arr[i] = { id: p.id, x: ll.lng, y: ll.lat };
            return { ...e, points: arr };
          });
          if (p.id != null) setWpOverrides((o) => ({ ...o, [p.id]: { x: ll.lng, y: ll.lat } }));
        });
        marker.on("dragend", async () => {
          const ll = marker.getLngLat();
          const snapped = await snapCoord(ll.lng, ll.lat);
          marker.setLngLat([snapped.x, snapped.y]);
          setEdit((e) => {
            const arr = e.points.slice();
            arr[i] = { id: p.id, x: snapped.x, y: snapped.y };
            return { ...e, points: arr };
          });
          // Live-preview: neighbours sharing this waypoint move too (unsaved).
          if (p.id != null) setWpOverrides((o) => ({ ...o, [p.id]: { x: snapped.x, y: snapped.y } }));
          dragging.current = false;
        });
        return { marker, el, base: "#f59e0b" };
      });
    }
  }, [map, mode, edit?.points.length]);

  // Highlight the hovered waypoint's marker on the map.
  useEffect(() => {
    editMarkers.current.forEach(({ el, base }, i) => {
      const on = i === hoverWp;
      el.style.background = on ? "#ef4444" : (base || "#f59e0b");
      el.style.color = on ? "#fff" : "#111";
      el.style.zIndex = on ? "10" : "1";
      el.style.boxShadow = on
        ? "0 0 0 3px rgba(239,68,68,.55), 0 0 10px rgba(0,0,0,.7)"
        : "0 0 6px rgba(0,0,0,.6)";
    });
  }, [hoverWp, edit?.points.length, mode]);

  // ---- Road snapping ----
  const snapCoord = async (lon, lat) => {
    if (!citySlug) return { x: lon, y: lat };
    try {
      const r = await apiFetch(`/api/cities/${citySlug}/snap?lon=${lon}&lat=${lat}`);
      const j = await r.json();
      if (Number.isFinite(j.lon) && Number.isFinite(j.lat)) return { x: j.lon, y: j.lat };
    } catch { /* ignore */ }
    return { x: lon, y: lat };
  };

  const nearPx = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= CLICK_TOL_PX;
  const snapToExisting = (px) => {
    let best = null, bestD = CLICK_TOL_PX;
    for (const w of existingWps) {
      const q = map.project([w.x, w.y]);
      const d = Math.hypot(px.x - q.x, px.y - q.y);
      if (d <= bestD) { bestD = d; best = w; }
    }
    return best;
  };

  const onMapClick = async (e) => {
    if (!mode || dragging.current) return;
    const px = map.project(e.lngLat);
    const raw = { x: e.lngLat.lng, y: e.lngLat.lat };
    if (mode === "create") {
      if (create.points.length >= 3 && nearPx(px, map.project([create.points[0].x, create.points[0].y]))) {
        setCreate((d) => ({ ...d, closed: true }));
        return;
      }
      const shared = snapToExisting(px);
      if (shared) {
        setCreate((d) => ({ ...d, points: [...d.points, { id: shared.id, x: shared.x, y: shared.y }], closed: false }));
        return;
      }
      setSnapping(true);
      const p = await snapCoord(raw.x, raw.y);
      setSnapping(false);
      setCreate((d) => ({ ...d, points: [...d.points, p], closed: false }));
    } else if (mode === "edit") {
      setSnapping(true);
      const p = await snapCoord(raw.x, raw.y);
      setSnapping(false);
      setEdit((d) => ({ ...d, points: insertNearestEdge(d.points, p) }));
    } else if (mode === "divide") {
      setSnapping(true);
      const p = await snapCoord(raw.x, raw.y);
      setSnapping(false);
      setDivide((d) => ({ ...d, points: [...d.points, p] }));
    }
  };
  useEffect(() => {
    if (!map || !mode) return;
    map.on("click", onMapClick);
    return () => map.off("click", onMapClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mode, create, edit, divide, existingWps]);

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

  // ---- Actions ----
  const startCreate = () => { reset(); setMode("create"); setCreate({ name: "", points: [], closed: false }); };

  const startEdit = (a) => {
    reset();
    const pts = (a.outline && a.outline.length) ? a.outline.map((w) => ({ id: w.id, x: w.x, y: w.y })) : [];
    setMode("edit");
    setEdit({ id: a.id, name: a.name, points: pts });
    setActive(a.id);
    // Camera intentionally left unchanged.
  };

  const startDivide = (a) => {
    reset();
    setMode("divide");
    setDivide({ id: a.id, name: a.name, points: [], name1: a.name + " A", name2: a.name + " B" });
    setActive(a.id);
    // Camera intentionally left unchanged.
  };

  const startEditById = (id) => {
    const a = areas.find((x) => x.id === id);
    if (a) startEdit(a);
  };
  const openOptions = (id) => {
    const a = areas.find((x) => x.id === id);
    if (a) setOptions({ id, name: a.name, color: a.color || DEFAULT_COLOR, mergeWith: "" });
  };
  const saveAreaOptions = async () => {
    if (!options) return;
    try {
      const resp = await apiFetch(`/api/cities/${citySlug}/areas/${options.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: options.name, color: options.color }),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      setOptions(null);
      await refresh();
    } catch (e) { setError(e.message); }
  };
  const mergeArea = async () => {
    if (!options?.mergeWith) return;
    const other = areas.find((a) => a.id === Number(options.mergeWith));
    if (!window.confirm(`Merge "${areas.find((a) => a.id === options.id)?.name}" with "${other?.name}"?`)) return;
    try {
      const resp = await apiFetch(`/api/cities/${citySlug}/areas/${options.id}/merge`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ other_id: Number(options.mergeWith), name: options.name }),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      setOptions(null);
      await refresh();
    } catch (e) { setError(e.message); }
  };

  const campaign = campaigns.find((c) => c.id === selectedCampaignId) || null;
  const linksCampaign = campaigns.find((c) => c.id === linksFor) || null;
  const copyLink = async (url, areaId) => {
    try { await navigator.clipboard.writeText(url); setCopiedId(areaId); setTimeout(() => setCopiedId(null), 1500); } catch { /* ignore */ }
  };

  // ---- Campaigns ----
  const createCampaign = async () => {
    if (!newCampaign.trim()) return;
    try {
      const resp = await apiFetch(`/api/cities/${citySlug}/campaigns`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCampaign }),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      setNewCampaign("");
      const cid = await loadCampaigns(json.id);
      await loadRoutes(cid);
      setError(null);
    } catch (e) { setError(e.message); }
  };
  const deleteCampaign = async (c) => {
    if (!window.confirm(`Delete campaign "${c.name}"? All routes drawn in it will be removed.`)) return;
    try {
      const resp = await apiFetch(`/api/campaigns/${c.id}`, { method: "DELETE" });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      const cid = await loadCampaigns(c.id);
      await loadRoutes(cid);
    } catch (e) { setError(e.message); }
  };
  const selectCampaign = (id) => { setSelectedCampaignId(id); setError(null); };

  const deleteArea = async (a) => {
    if (!window.confirm(`Delete area "${a.name}"? This also removes its routes.`)) return;
    try {
      const resp = await apiFetch(`/api/cities/${citySlug}/areas/${a.id}`, { method: "DELETE" });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      await refresh();
      if (active === a.id) reset();
    } catch (e) { setError(e.message); }
  };

  const deleteEditWaypoint = (i) => {
    setEdit((d) => {
      if (d.points.length <= 3) return d;
      const arr = d.points.slice();
      arr.splice(i, 1);
      return { ...d, points: arr };
    });
  };

  const saveCreate = async () => {
    if (!create.name.trim() || create.points.length < 3) return setError("Name the area and draw at least 3 points.");
    setBusy(true); setError(null);
    try {
      const resp = await apiFetch(`/api/cities/${citySlug}/areas`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: create.name, outline: create.points }),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      await refresh();
      reset();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const saveEdit = async () => {
    const e = editRef.current; // latest points (label callback may be stale)
    if (!e || !e.name.trim() || e.points.length < 3) return setError("Name the area and keep at least 3 waypoints.");
    setBusy(true); setError(null);
    try {
      const resp = await apiFetch(`/api/cities/${citySlug}/areas/${e.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: e.name, points: e.points }),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      await refresh();
      reset();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const saveDivide = async () => {
    if (!divide || !divide.name1.trim() || !divide.name2.trim() || divide.points.length < 2)
      return setError("Name both new areas and draw a dividing line across the area.");
    setBusy(true); setError(null);
    try {
      const resp = await apiFetch(`/api/cities/${citySlug}/areas/${divide.id}/divide`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name1: divide.name1, name2: divide.name2, dividing: divide.points.map((p) => [p.x, p.y]) }),
      });
      const json = await readJson(resp);
      if (!resp.ok) throw new Error(json.error);
      await refresh();
      reset();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const hint = () => {
    if (mode === "create") return create.closed ? "Polygon closed. Review and Save." : "Click vertices (snaps to roads / existing waypoints). Click the first again to close.";
    if (mode === "edit") return "Drag waypoints (snap to roads). Click to add. Shared waypoints update other areas.";
    if (mode === "divide") return "Draw a polyline across the area (snaps to roads). Its points become shared waypoints of both halves.";
    return "";
  };

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {menuOpen ? (
      <div style={{ position: "absolute", top: 50, left: 12, width: 340, maxHeight: "calc(100% - 70px)", overflow: "auto", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 14, zIndex: 10 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>CollabMap — Admin</h2>
          <button className="ghost" title="Collapse menu" onClick={() => setMenuOpen(false)} style={{ padding: "0 8px" }}>«</button>
        </div>

        <label className="hint">City</label>
        <select value={citySlug || ""} onChange={(e) => selectCity(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
          {cities.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>

        <div className="col">
          <span className="hint">Campaigns ({campaigns.length}) — select one to get area links</span>
          <div className="row">
            <input
              placeholder="New campaign name"
              value={newCampaign}
              onChange={(e) => setNewCampaign(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createCampaign(); }}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button onClick={createCampaign} disabled={!newCampaign.trim()}>Start</button>
          </div>
          <div style={{ maxHeight: 140, overflow: "auto" }}>
            {campaigns.map((c) => (
              <div
                key={c.id}
                className="row"
                onClick={() => selectCampaign(c.id)}
                style={{
                  justifyContent: "space-between", padding: "3px 4px", borderRadius: 4, cursor: "pointer",
                  background: c.id === selectedCampaignId ? "rgba(62,166,255,0.22)" : "transparent",
                }}
              >
                <span className="grow">{c.id === selectedCampaignId ? "● " : "○ "}{c.name}</span>
                <span className="hint">{c.route_count ?? 0} routes</span>
                <button className="ghost" onClick={(e) => { e.stopPropagation(); setLinksFor(c.id); }}>Links</button>
                <button className="ghost" onClick={(e) => { e.stopPropagation(); deleteCampaign(c); }}>Del</button>
              </div>
            ))}
            {campaigns.length === 0 && <span className="hint">No campaigns yet — start one to create area links.</span>}
          </div>
        </div>

        <hr style={{ borderColor: "var(--border)" }} />

        {mode === "create" && (
          <div className="col">
            <span className="hint">Draw a new area. Points snap to roads; click near an existing waypoint to share it.</span>
            <input placeholder="Area name" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} style={{ width: "100%" }} />
            <div className="row">
              <button className="ghost grow" onClick={startCreate} disabled={create.points.length === 0}>Restart</button>
              <button className="grow" onClick={saveCreate} disabled={busy || create.points.length < 3}>
                {busy ? "Snapping…" : "Save area"}
              </button>
              <button className="ghost" onClick={reset}>Done</button>
            </div>
            <span className="hint">{hint()} ({create.points.length})</span>
          </div>
        )}

        {mode === "edit" && (
          <div className="col">
            <span className="hint">Editing area.</span>
            <input placeholder="Area name" value={edit?.name || ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} style={{ width: "100%" }} />
            <span className="hint">Waypoints ({edit?.points.length || 0}) — delete to remove:</span>
            <div style={{ maxHeight: 160, overflow: "auto" }}>
              {edit?.points.map((p, i) => (
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
                  <span className="grow">
                    #{i + 1} {p.x.toFixed(5)}, {p.y.toFixed(5)} {p.id ? <em style={{ color: "var(--muted)" }}>shared</em> : <em style={{ color: "var(--muted)" }}>new</em>}
                  </span>
                  <button className="ghost" disabled={edit.points.length <= 3} onClick={() => deleteEditWaypoint(i)}>Delete</button>
                </div>
              ))}
            </div>
            <span className="hint">{hint()}</span>
            <span className="hint">Use <b>save</b> / <b>cancel</b> under the area name on the map.</span>
          </div>
        )}

        {mode === "divide" && (
          <div className="col">
            <span className="hint">Divide "{divide?.name}":</span>
            <input placeholder="Area 1 name" value={divide?.name1 || ""} onChange={(e) => setDivide({ ...divide, name1: e.target.value })} style={{ width: "100%" }} />
            <input placeholder="Area 2 name" value={divide?.name2 || ""} onChange={(e) => setDivide({ ...divide, name2: e.target.value })} style={{ width: "100%" }} />
            <div className="row">
              <button className="grow" onClick={saveDivide} disabled={busy || !divide || divide.points.length < 2}>
                {busy ? "Splitting…" : "Divide"}
              </button>
              <button className="ghost" onClick={() => setDivide((d) => ({ ...d, points: [] }))} disabled={!divide || divide.points.length === 0}>Clear line</button>
              <button className="ghost" onClick={reset}>Cancel</button>
            </div>
            <span className="hint">{hint()} ({divide?.points.length || 0} pts)</span>
          </div>
        )}

        {!mode && (
          <div className="row">
            <button className="grow" onClick={startCreate}>Draw new area</button>
          </div>
        )}

        {snapping && <div className="hint" style={{ marginTop: 6 }}>Snapping to road…</div>}
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
      ) : (
        <button title="Expand menu" onClick={() => setMenuOpen(true)} style={{ position: "absolute", top: 50, left: 12, zIndex: 10, background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontWeight: 600, cursor: "pointer" }}>☰ Menu</button>
      )}

      {linksCampaign && (
        <div
          onClick={() => setLinksFor(null)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 560, maxWidth: "90%", maxHeight: "80%", overflow: "auto", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}
          >
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Links — {linksCampaign.name}</h3>
              <button className="ghost" onClick={() => setLinksFor(null)}>Close</button>
            </div>
            <p className="hint">One link per area. Anyone with a link records routes for this campaign.</p>
            <div className="col">
              {areas.map((a) => {
                const url = `${window.location.origin}/area/${a.share_token}/${linksCampaign.token}`;
  if (tokenInvalid) {
    return (
      <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div>
          <h2 style={{ margin: "0 0 6px" }}>Admin token required</h2>
          <p className="hint">This admin link is missing or invalid. Use the admin link printed by the server (<code>/admin/&lt;token&gt;</code>).</p>
        </div>
      </div>
    );
  }

  return (
                  <div key={a.id} className="row" style={{ gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: a.color || DEFAULT_COLOR, flex: "0 0 auto" }} />
                    <span style={{ width: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.name}>{a.name}</span>
                    <input readOnly value={url} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
                    <button className="ghost" onClick={() => copyLink(url, a.id)}>{copiedId === a.id ? "Copied!" : "Copy"}</button>
                  </div>
                );
              })}
              {areas.length === 0 && <span className="hint">No areas yet.</span>}
            </div>
          </div>
        </div>
      )}

      {options && (
        <div
          onClick={() => setOptions(null)}
          style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 380, maxWidth: "90%", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}
          >
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Area options</h3>
              <button className="ghost" onClick={() => setOptions(null)}>Close</button>
            </div>

            <label className="hint">Name</label>
            <input value={options.name} onChange={(e) => setOptions({ ...options, name: e.target.value })} style={{ width: "100%" }} />

            <label className="hint" style={{ marginTop: 10, display: "block" }}>Colour</label>
            <div className="row">
              <input type="color" value={options.color} onChange={(e) => setOptions({ ...options, color: e.target.value })} style={{ width: 48, height: 30, padding: 0 }} />
              <span className="hint">{options.color}</span>
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <button className="grow" onClick={saveAreaOptions} disabled={!options.name.trim()}>Save name &amp; colour</button>
            </div>

            <hr style={{ borderColor: "var(--border)", margin: "12px 0" }} />

            <div className="row">
              <button className="grow" onClick={() => { const a = areas.find((x) => x.id === options.id); setOptions(null); if (a) startDivide(a); }}>Divide</button>
              <button className="grow" onClick={() => { const a = areas.find((x) => x.id === options.id); setOptions(null); if (a) deleteArea(a); }}>Delete</button>
            </div>

            <hr style={{ borderColor: "var(--border)", margin: "12px 0" }} />

            <span className="hint">Merge with an adjacent area (shares an edge):</span>
            <div className="row">
              <select value={options.mergeWith} onChange={(e) => setOptions({ ...options, mergeWith: e.target.value })} style={{ flex: 1, minWidth: 0 }}>
                <option value="">Select area…</option>
                {areas
                  .filter((a) => a.id !== options.id && sharesEdge(areas.find((x) => x.id === options.id) || {}, a))
                  .map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button onClick={mergeArea} disabled={!options.mergeWith}>Merge</button>
            </div>

            {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}