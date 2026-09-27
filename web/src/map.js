import React, { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export function useMap(containerRef, opts = {}) {
  const mapRef = useRef(null);
  const [map, setMap] = useState(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: opts.center || [12.568, 55.676],
      zoom: opts.zoom ?? 12,
    });
    m.addControl(new maplibregl.NavigationControl(), "top-left");
    m.on("load", () => setMap(m));
    mapRef.current = m;
    return () => {
      m.remove();
      mapRef.current = null;
      setMap(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return map;
}

// Draw a polyline onto the map (optionally cleared each update).
export function setLine(map, id, coords, paint = {}) {
  const src = id;
  if (map.getSource(src)) map.removeLayer(id + "-line");
  if (map.getSource(src)) map.removeSource(src);
  if (!coords || coords.length < 2) return;
  map.addSource(src, { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
  map.addLayer({
    id: id + "-line",
    type: "line",
    source: src,
    paint: {
      "line-color": paint.color || "#3ea6ff",
      "line-width": paint.width || 3,
      "line-opacity": paint.opacity ?? 1,
    },
  });
}

export function setFill(map, id, polygon, paint = {}) {
  const src = id;
  if (map.getSource(src)) {
    map.removeLayer(id + "-fill");
    map.removeLayer(id + "-border");
    map.removeSource(src);
  }
  if (!polygon) return;
  map.addSource(src, { type: "geojson", data: { type: "Feature", properties: {}, geometry: polygon } });
  map.addLayer({
    id: id + "-fill",
    type: "fill",
    source: src,
    paint: { "fill-color": paint.fill || "#3ea6ff", "fill-opacity": paint.opacity ?? 0.2 },
  });
  map.addLayer({
    id: id + "-border",
    type: "line",
    source: src,
    paint: { "line-color": paint.border || "#3ea6ff", "line-width": paint.width || 2 },
  });
}

// Darken everything OUTSIDE the given polygon: the area stays clear while the
// rest of the map is dimmed. polygon is a GeoJSON Polygon.
export function setMask(map, id, polygon, opacity = 0.55) {
  const src = id;
  if (map.getSource(src)) {
    map.removeLayer(id + "-mask");
    map.removeSource(src);
  }
  if (!polygon) return;
  const outer = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const hole = polygon.coordinates[0].slice();
  // MapLibre's GeoJSON tiler only treats a ring as a hole when its winding is
  // opposite to the outer ring. Force that so the area isn't filled too.
  if (Math.sign(ringArea(outer)) === Math.sign(ringArea(hole))) hole.reverse();
  map.addSource(src, {
    type: "geojson",
    data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [outer, hole] } },
  });
  map.addLayer({
    id: id + "-mask",
    type: "fill",
    source: src,
    paint: { "fill-color": "#000000", "fill-opacity": opacity },
  });
}

// Signed area (shoelace) of a closed ring; sign gives the winding direction.
function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

// Draw many routes in a single layer, coloured per-feature via a "color" property.
// features: GeoJSON Feature[] (LineString) with properties.color.
export function drawRoutes(map, id, features, paint = {}) {
  const src = id;
  if (map.getLayer(id + "-line")) map.removeLayer(id + "-line");
  if (map.getSource(src)) map.removeSource(src);
  if (!features || !features.length) return;
  map.addSource(src, { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({
    id: id + "-line",
    type: "line",
    source: src,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["coalesce", ["get", "color"], paint.color || "#64748b"],
      "line-width": paint.width || 5,
      "line-opacity": paint.opacity ?? 0.9,
    },
  });
}

const markerGroups = new Map();

export function setMarkers(map, points, opts = {}) {
  const group = opts.group || "default";
  clearMarkers(map, group);
  if (!points) return;
  const list = [];
  for (const p of points) {
    const el = document.createElement("div");
    el.style.width = el.style.height = opts.size || "8px";
    el.style.background = opts.color || "#fff";
    el.style.borderRadius = "50%";
    el.style.boxShadow = "0 0 0 2px #000";
    list.push(new maplibregl.Marker({ element: el }).setLngLat([p[0], p[1]]).addTo(map));
  }
  markerGroups.set(group, list);
}

export function clearMarkers(map, group) {
  const list = markerGroups.get(group);
  if (!list) return;
  for (const m of list) m.remove();
  markerGroups.set(group, []);
}

export function clearLayer(map, group) {
  clearMarkers(map, group);
}

// Render centered area-name labels with edit/options icons.
// items: [{ id, name, color, center }].
// opts: { onEdit(id), onOptions(id), editingId, onSave(), onCancel() }.
export function setLabels(map, id, items, opts = {}) {
  clearMarkers(map, id);
  if (!items || !items.length) return;
  const btn = (text, handler) => {
    const b = document.createElement("button");
    b.textContent = text;
    Object.assign(b.style, {
      background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.3)",
      color: "#fff", cursor: "pointer", borderRadius: "3px",
      padding: "0 5px", fontSize: "11px", fontWeight: 700, lineHeight: "16px",
    });
    b.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
    return b;
  };
  const icon = (glyph, title, handler, areaId) => {
    const b = document.createElement("button");
    b.textContent = glyph;
    b.title = title;
    Object.assign(b.style, {
      background: "transparent", border: "none", color: "#e2e8f0",
      cursor: "pointer", padding: "0 1px", fontSize: "13px", lineHeight: "1",
    });
    b.addEventListener("click", (e) => { e.stopPropagation(); handler(areaId); });
    return b;
  };
  const list = [];
  for (const it of items) {
    const editing = opts.editingId != null && it.id === opts.editingId;
    const el = document.createElement("div");
    Object.assign(el.style, {
      display: "flex", flexDirection: editing ? "column" : "row",
      alignItems: "center", gap: "5px",
      color: "#fff", fontSize: "13px", fontWeight: 700,
      textShadow: "0 1px 2px #000, 0 0 2px #000",
      background: "rgba(16,20,24,0.7)",
      border: `2px solid ${it.color || "rgba(255,255,255,0.25)"}`,
      borderRadius: "5px", padding: "1px 6px", whiteSpace: "nowrap",
      pointerEvents: "auto",
    });
    const nameSpan = document.createElement("span");
    nameSpan.textContent = it.name;
    el.appendChild(nameSpan);
    if (editing) {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "4px" });
      if (opts.onSave) row.appendChild(btn("save", opts.onSave));
      if (opts.onCancel) row.appendChild(btn("cancel", opts.onCancel));
      el.appendChild(row);
    } else {
      if (opts.onEdit) el.appendChild(icon("✎", "Edit area", opts.onEdit, it.id));
      if (opts.onOptions) el.appendChild(icon("⚙", "Area options", opts.onOptions, it.id));
    }
    list.push(new maplibregl.Marker({ element: el }).setLngLat(it.center).addTo(map));
  }
  markerGroups.set(id, list);
}

export default maplibregl;