const BASE = `http://127.0.0.1:${process.env.OSRM_PORT || 5000}`;

function coordsArg(coods) {
  return coods.map((c) => `${c.lon},${c.lat}`).join(";");
}

async function get(path) {
  const res = await fetch(BASE + path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.code !== "Ok") {
    const e = new Error(`Routing failed (OSRM HTTP ${res.status}): ${json.message || json.code || "unknown error"}`);
    e.code = json.code || "Unknown";
    e.status = res.status;
    throw e;
  }
  return json;
}

export function sendCoords(geometry) {
  // GeoJSON geometry -> array of {lon, lat}
  if (!geometry) return [];
  if (geometry.type === "Point") return [coord(geometry.coordinates)];
  if (geometry.type === "LineString" || geometry.type === "MultiPoint") {
    return geometry.coordinates.map(coord);
  }
  if (geometry.type === "Polygon") {
    return geometry.coordinates[0].map(coord); // outer ring
  }
  return [];
}

function coord(c) {
  return { lon: Number(c[0]), lat: Number(c[1]) };
}

// Route between an ordered list of coords, returning snapped walking path.
export async function route(coords) {
  const argc = coordsArg(coords);
  const json = await get(
    `/route/v1/foot/${argc}?geometries=geojson&overview=full&steps=false`
  );
  const route = json.routes?.[0];
  if (!route) throw new Error("OSRM returned no route");
  return {
    path: sendCoords(route.geometry),
    distance_m: route.distance,
    duration_s: route.duration,
  };
}

// Snap a single coordinate onto the street network.
export async function nearest(coords) {
  const json = await get(`/nearest/v1/foot/${coords.lon},${coords.lat}?number=1`);
  const w = json.waypoints?.[0];
  if (!w) return null;
  return {
    lon: w.location[0],
    lat: w.location[1],
    distance_m: w.distance,
  };
}

// Map-match a drawn trace onto the street network. Used for freehand drawing.
export async function match(coords) {
  const argc = coordsArg(coords);
  const json = await get(
    `/match/v1/foot/${argc}?geometries=geojson&overview=full&tidy=true`
  );
  const trace = json.tracepoints || [];
  const pts = trace.filter((t) => t && t.location).map((t) => ({ lon: t.location[0], lat: t.location[1] }));
  if (pts.length === 0) throw new Error("OSRM match returned no points");
  return { path: pts, distance_m: json.matchings?.[0]?.distance || 0 };
}