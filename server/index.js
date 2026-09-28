import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, generateToken, slugify, ensureDefaultCities, getSetting, setSetting } from "./db.js";
import * as osrm from "./osrm.js";
import { splitRing, openRing, simplifyLine } from "./geo.js";

const app = express();
const PORT = process.env.PORT || 4321;

app.use(express.json({ limit: "2mb" }));

ensureDefaultCities();

// Admin token: protects the admin API (and therefore the admin UI at /admin/<token>).
function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) {
    setSetting("admin_token", process.env.ADMIN_TOKEN);
    return process.env.ADMIN_TOKEN;
  }
  let t = getSetting("admin_token");
  if (!t) {
    t = crypto.randomBytes(16).toString("hex");
    setSetting("admin_token", t);
  }
  return t;
}
const ADMIN_TOKEN = loadAdminToken();

// Endpoints the public area page needs (no admin token required).
function isPublic(req) {
  const p = req.path;
  if (!p.startsWith("/api/")) return true; // static assets, SPA routes, /a/...
  if (req.method === "GET" && p.startsWith("/a/")) return true;
  if (req.method === "GET" && /^\/api\/cities\/[^/]+\/snap$/.test(p)) return true;
  if (req.method === "POST" && /^\/api\/areas\/[^/]+\/routes$/.test(p)) return true;
  if ((req.method === "PUT" || req.method === "DELETE") && /^\/api\/routes\/[^/]+$/.test(p)) return true;
  return false;
}
app.use((req, res, next) => {
  if (isPublic(req)) return next();
  if (req.get("x-admin-token") === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "admin token required" });
});

const cityBySlug = (slug) => db.prepare("SELECT * FROM cities WHERE slug = ?").get(slug);
const cityById = (id) => db.prepare("SELECT * FROM cities WHERE id = ?").get(id);
const areaById = (id) => db.prepare("SELECT * FROM areas WHERE id = ?").get(id);

// --- Cities ---------------------------------------------------------------
app.get("/api/cities", (req, res) => {
  const rows = db.prepare("SELECT * FROM cities ORDER BY name").all();
  res.json(rows.map((r) => ({ ...r, bbox: JSON.parse(r.bbox), center: r.center ? JSON.parse(r.center) : undefined })));
});

app.get("/api/cities/:city", (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  res.json({ ...c, bbox: JSON.parse(c.bbox), center: c.center ? JSON.parse(c.center) : undefined });
});

// --- Areas ----------------------------------------------------------------
app.get("/api/cities/:city/areas", (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const rows = db.prepare("SELECT * FROM areas WHERE city_id = ? ORDER BY name").all(c.id);
  res.json(rows.map((r) => ({ ...parseArea(r), city: c.name })));
});

// Routes in a city, optionally filtered by campaign (used on the admin map).
app.get("/api/cities/:city/routes", (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const campaignId = req.query.campaign_id ? Number(req.query.campaign_id) : null;
  const rows = campaignId
    ? db
        .prepare(
          "SELECT r.* FROM routes r JOIN areas a ON a.id = r.area_id WHERE a.city_id = ? AND r.campaign_id = ? ORDER BY r.created_at DESC"
        )
        .all(c.id, campaignId)
    : db
        .prepare(
          "SELECT r.* FROM routes r JOIN areas a ON a.id = r.area_id WHERE a.city_id = ? ORDER BY r.created_at DESC"
        )
        .all(c.id);
  res.json(rows.map(parseRoute));
});

// --- Campaigns ------------------------------------------------------------
app.get("/api/cities/:city/campaigns", (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const rows = db.prepare("SELECT * FROM campaigns WHERE city_id = ? ORDER BY created_at DESC").all(c.id);
  res.json(rows.map((r) => ({ ...r, route_count: db.prepare("SELECT COUNT(*) n FROM routes WHERE campaign_id = ?").get(r.id).n })));
});

app.post("/api/cities/:city/campaigns", (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const { name } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "campaign name required" });
  const token = generateToken();
  const r = db.prepare("INSERT INTO campaigns (city_id, name, token) VALUES (?,?,?)").run(c.id, name.trim(), token);
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(Number(r.lastInsertRowid));
  res.status(201).json({ ...campaign, route_count: 0 });
});

// Deleting a campaign removes all routes drawn in it.
app.delete("/api/campaigns/:id", (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(Number(req.params.id));
  if (!campaign) return res.status(404).json({ error: "campaign not found" });
  db.transaction(() => {
    db.prepare("DELETE FROM routes WHERE campaign_id = ?").run(campaign.id);
    db.prepare("DELETE FROM campaigns WHERE id = ?").run(campaign.id);
  })();
  res.json({ ok: true });
});

function parseArea(r) {
  return { ...r, polygon: JSON.parse(r.polygon), outline: getOutline(r.id) };
}

// Ordered waypoint objects [{id,x,y}] for an area (open ring).
function getOutline(areaId) {
  return db
    .prepare(
      "SELECT w.id, w.lon AS x, w.lat AS y FROM area_waypoints aw JOIN waypoints w ON w.id = aw.waypoint_id WHERE aw.area_id = ? ORDER BY aw.seq"
    )
    .all(areaId);
}

// Ordered waypoint ids for an area (open ring).
function outlineIds(areaId) {
  return db.prepare("SELECT waypoint_id FROM area_waypoints WHERE area_id = ? ORDER BY seq").all(areaId).map((r) => r.waypoint_id);
}

function setOutline(areaId, ids) {
  db.prepare("DELETE FROM area_waypoints WHERE area_id = ?").run(areaId);
  const ins = db.prepare("INSERT INTO area_waypoints (area_id, waypoint_id, seq) VALUES (?,?,?)");
  ids.forEach((wid, i) => ins.run(areaId, wid, i));
}

const SNAP_DEG = 0.00015; // ~16 m: treat near-identical locations as the same waypoint
// Simplification tolerance (metres) for recorded walking routes.
const SIMPLIFY_ROUTE_M = 8;
function distDeg(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Resolve a point spec ({id?,x,y}) to a waypoint id. Prefers an explicit id,
// otherwise reuses an existing waypoint within SNAP_DEG (enables sharing), else
// creates a new waypoint.
function resolveWaypoint(cityId, p) {
  const x = Number(p.x), y = Number(p.y);
  if (p.id) {
    const w = db.prepare("SELECT id FROM waypoints WHERE id = ? AND city_id = ?").get(p.id, cityId);
    if (w) return Number(w.id);
  }
  const all = db.prepare("SELECT id, lon AS x, lat AS y FROM waypoints WHERE city_id = ?").all(cityId);
  for (const w of all) {
    if (distDeg(w, { x, y }) <= SNAP_DEG) return Number(w.id);
  }
  const r = db.prepare("INSERT INTO waypoints (city_id, lon, lat) VALUES (?,?,?)").run(cityId, x, y);
  return Number(r.lastInsertRowid);
}

function resolveOutline(cityId, outline) {
  return outline.map((p) => resolveWaypoint(cityId, p));
}

// Colour palette + neighbour-aware colour assignment (neighbours share a waypoint).
const PALETTE = [
  "#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4",
  "#f032e6", "#bfef45", "#fabed4", "#469990", "#dcbeff", "#9A6324",
  "#800000", "#808000", "#000075", "#4363d8",
];

function pickFromUsed(usedColors) {
  const used = new Set(usedColors.filter(Boolean));
  for (const c of PALETTE) if (!used.has(c)) return c;
  return PALETTE[0];
}

// Areas that share at least one waypoint with the given ids (excluding `excludeId`).
function neighborAreas(cityId, waypointIds, excludeId = null) {
  if (!waypointIds.length) return [];
  const ph = waypointIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT a.* FROM areas a JOIN area_waypoints aw ON aw.area_id = a.id WHERE a.city_id = ? AND aw.waypoint_id IN (${ph})`
    )
    .all(cityId, ...waypointIds);
  return rows.filter((a) => a.id !== excludeId);
}

// Delete waypoints no longer referenced by any area.
function cleanupOrphanWaypoints(cityId) {
  db.prepare(
    "DELETE FROM waypoints WHERE city_id = ? AND id NOT IN (SELECT waypoint_id FROM area_waypoints)"
  ).run(cityId);
}

// A slug that is unique within the city (appends -2, -3, … on collision).
function uniqueSlug(cityId, name, excludeId = null) {
  const base = slugify(name);
  const taken = db.prepare("SELECT id FROM areas WHERE city_id = ? AND slug = ?");
  let slug = base;
  let i = 1;
  let row;
  while ((row = taken.get(cityId, slug)) && row.id !== excludeId) {
    i += 1;
    slug = `${base}-${i}`;
  }
  return slug;
}

// Build an area polygon from a waypoint outline. Edges are the direct shortest
// line between consecutive waypoints (a walking boundary may cross roads anywhere),
// so boundaries never take convoluted detours along the routing network.
function polygonFromOutline(outline) {
  const coords = outline.map((p) => [Number(p.x), Number(p.y)]);
  if (coords.length < 3) throw new Error("area needs at least 3 waypoints");
  return { type: "Polygon", coordinates: [[...coords, coords[0]]] };
}

// Create an area from a list of point specs [{id?,x,y}] making up its outline.
async function createArea(cityId, name, outline) {
  const snapped = polygonFromOutline(outline);
  const ids = resolveOutline(cityId, outline);
  const color = pickFromUsed(neighborAreas(cityId, ids).map((a) => a.color));
  const token = generateToken();
  const slug = uniqueSlug(cityId, name);
  let areaId;
  db.transaction(() => {
    const result = db
      .prepare("INSERT INTO areas (city_id, slug, name, color, polygon, share_token) VALUES (?,?,?,?,?,?)")
      .run(cityId, slug, name, color, JSON.stringify(snapped), token);
    areaId = Number(result.lastInsertRowid);
    const inset = db.prepare("INSERT INTO area_waypoints (area_id, waypoint_id, seq) VALUES (?,?,?)");
    ids.forEach((wid, seq) => inset.run(areaId, wid, seq));
  })();
  return parseArea(areaById(areaId));
}

// Create an area. Body: { name, outline: [{id?,x,y},...] }.
app.post("/api/cities/:city/areas", async (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });

  const { name, outline } = req.body;
  if (!name || !Array.isArray(outline) || outline.length < 3) {
    return res.status(400).json({ error: "name and outline (>=3 waypoints) required" });
  }
  try {
    const area = await createArea(c.id, name, outline);
    res.status(201).json(area);
  } catch (e) {
    console.error("CREATE AREA THREW:", e);
    res.status(500).json({ error: e.message });
  }
});

// Edit an area: rename and/or move its waypoints. Moving a shared waypoint
// updates every area that references it.
// Body: { name?, points: [{id?,x,y},...] } (the new outline, in order).
app.put("/api/cities/:city/areas/:id", async (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const area = areaById(Number(req.params.id));
  if (!area || area.city_id !== c.id) return res.status(404).json({ error: "area not found" });

  const { name, points } = req.body || {};
  if (!Array.isArray(points) || points.length < 3) {
    return res.status(400).json({ error: "points (>=3) required" });
  }
  try {
    const movedIds = new Set();
    const newIds = new Set(); // waypoints created/inserted (no id supplied)
    const resolved = points.map((p) => {
      const wid = resolveWaypoint(c.id, p);
      if (p.id) {
        const u = db
          .prepare("UPDATE waypoints SET lon = ?, lat = ? WHERE id = ? AND city_id = ?")
          .run(Number(p.x), Number(p.y), Number(p.id), c.id);
        if (u.changes) movedIds.add(Number(p.id));
      } else {
        newIds.add(wid);
      }
      return wid;
    });

    const affected = new Set([area.id]);
    db.transaction(() => {
      setOutline(area.id, resolved);
      if (typeof name === "string" && name.trim()) {
        db.prepare("UPDATE areas SET name = ?, slug = ? WHERE id = ?").run(name.trim(), uniqueSlug(c.id, name.trim(), area.id), area.id);
      }
    })();

    // Propagate newly-inserted waypoints to neighbouring areas whose shared edge
    // they fall on, so the new waypoint is shared by both areas.
    const others = db.prepare("SELECT id FROM areas WHERE city_id = ? AND id != ?").all(c.id, area.id);
    const n = resolved.length;
    for (let i = 0; i < n; i++) {
      if (!newIds.has(resolved[i])) continue;
      const a = resolved[(i - 1 + n) % n];
      const b = resolved[(i + 1) % n];
      if (a === b) continue;
      for (const other of others) {
        const ids = outlineIds(other.id);
        if (ids.includes(resolved[i])) continue;
        const posA = ids.indexOf(a), posB = ids.indexOf(b);
        if (posA === -1 || posB === -1) continue;
        const m = ids.length;
        let insertAt = -1;
        if (posB === (posA + 1) % m) insertAt = posA + 1;
        else if (posA === (posB + 1) % m) insertAt = posB + 1;
        if (insertAt === -1) continue;
        const next = ids.slice();
        next.splice(insertAt, 0, resolved[i]);
        setOutline(other.id, next);
        affected.add(other.id);
      }
    }

    // Re-snap this area and every area sharing a moved waypoint.
    for (const wid of movedIds) {
      for (const r of db.prepare("SELECT area_id FROM area_waypoints WHERE waypoint_id = ?").all(wid)) affected.add(r.area_id);
    }
    cleanupOrphanWaypoints(c.id);
    const outAreas = [];
    for (const aid of affected) {
      const out = getOutline(aid);
      const snapped = polygonFromOutline(out);
      db.prepare("UPDATE areas SET polygon = ? WHERE id = ?").run(JSON.stringify(snapped), aid);
      outAreas.push(parseArea(areaById(aid)));
    }
    res.json({ areas: outAreas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Divide an area into two along an interior polyline. The dividing line's points
// become waypoints that are shared by both new areas.
// Body: { name1, name2, dividing: [[lon,lat],...] }.
app.post("/api/cities/:city/areas/:id/divide", async (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const area = areaById(Number(req.params.id));
  if (!area || area.city_id !== c.id) return res.status(404).json({ error: "area not found" });

  const { name1, name2, dividing } = req.body || {};
  if (!name1 || !name2 || !Array.isArray(dividing) || dividing.length < 2) {
    return res.status(400).json({ error: "name1, name2 and a dividing polyline required" });
  }
  try {
    const outline = getOutline(area.id);
    const ring = outline.map((p) => [p.x, p.y]);
    const [ring1, ring2] = splitRing(ring, dividing);

    if (openRing(ring1).length < 3 || openRing(ring2).length < 3) {
      return res.status(400).json({ error: "The dividing line must cut across the area; each half needs at least 3 corners." });
    }

    const o1 = openRing(ring1).map(([x, y]) => ({ x, y }));
    const o2 = openRing(ring2).map(([x, y]) => ({ x, y }));
    // Resolve shared waypoints (shared split points resolve to the same id).
    const ids1 = resolveOutline(c.id, o1);
    const ids2 = resolveOutline(c.id, o2);
    const snapped1 = polygonFromOutline(o1);
    const snapped2 = polygonFromOutline(o2);

    // Distinct colours for the two halves, avoiding the original's neighbours.
    const neighbours = neighborAreas(c.id, [...new Set([...ids1, ...ids2])], area.id);
    const usedColors = neighbours.map((a) => a.color);
    const color1 = pickFromUsed(usedColors);
    const color2 = pickFromUsed([...usedColors, color1]);

    let created;
    db.transaction(() => {
      db.prepare("DELETE FROM routes WHERE area_id = ?").run(area.id);
      db.prepare("DELETE FROM areas WHERE id = ?").run(area.id);
      const a1 = db
        .prepare("INSERT INTO areas (city_id, slug, name, color, polygon, share_token) VALUES (?,?,?,?,?,?)")
        .run(c.id, uniqueSlug(c.id, name1), name1, color1, JSON.stringify(snapped1), generateToken());
      const a2 = db
        .prepare("INSERT INTO areas (city_id, slug, name, color, polygon, share_token) VALUES (?,?,?,?,?,?)")
        .run(c.id, uniqueSlug(c.id, name2), name2, color2, JSON.stringify(snapped2), generateToken());
      const inset = db.prepare("INSERT INTO area_waypoints (area_id, waypoint_id, seq) VALUES (?,?,?)");
      ids1.forEach((wid, seq) => inset.run(Number(a1.lastInsertRowid), wid, seq));
      ids2.forEach((wid, seq) => inset.run(Number(a2.lastInsertRowid), wid, seq));
      created = [parseArea(areaById(Number(a1.lastInsertRowid))), parseArea(areaById(Number(a2.lastInsertRowid)))];
    })();
    cleanupOrphanWaypoints(c.id);

    res.status(201).json({ area1: created[0], area2: created[1] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update an area's name and/or colour. Body: { name?, color? }.
app.patch("/api/cities/:city/areas/:id", (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const area = areaById(Number(req.params.id));
  if (!area || area.city_id !== c.id) return res.status(404).json({ error: "area not found" });
  const { name, color } = req.body || {};
  try {
    if (typeof name === "string" && name.trim()) {
      db.prepare("UPDATE areas SET name = ?, slug = ? WHERE id = ?").run(name.trim(), uniqueSlug(c.id, name.trim(), area.id), area.id);
    }
    if (typeof color === "string" && color.trim()) {
      db.prepare("UPDATE areas SET color = ? WHERE id = ?").run(color.trim(), area.id);
    }
    res.json(parseArea(areaById(area.id)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Union of two area outlines (shared edges cancel out). Returns the merged
// waypoint-id ring, or null if the areas do not form a single shared boundary.
function unionOutlines(A, B) {
  const edges = new Map(); // "u,v" -> count
  const add = (u, v) => edges.set(`${u},${v}`, (edges.get(`${u},${v}`) || 0) + 1);
  for (const ids of [A, B]) {
    for (let i = 0; i < ids.length; i++) add(ids[i], ids[(i + 1) % ids.length]);
  }
  // Cancel edges that appear in both directions (shared boundary).
  const next = new Map();
  for (const [key, count] of edges) {
    const [u, v] = key.split(",").map(Number);
    for (let i = 0; i < count; i++) {
      if ((edges.get(`${v},${u}`) || 0) > 0) {
        edges.set(`${v},${u}`, edges.get(`${v},${u}`) - 1);
      } else {
        next.set(u, v);
      }
    }
  }
  if (!next.size) return null;
  const start = next.keys().next().value;
  const ring = [];
  let cur = start;
  const guard = next.size + 1;
  for (let i = 0; i < guard; i++) {
    ring.push(cur);
    cur = next.get(cur);
    if (cur === undefined) return null;
    if (cur === start) return ring;
  }
  return null; // not a single cycle (e.g. areas not edge-adjacent)
}

// Merge two areas into one (their shared boundary is dissolved).
// Body: { other_id, name? }.
app.post("/api/cities/:city/areas/:id/merge", async (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const area = areaById(Number(req.params.id));
  const other = areaById(Number((req.body || {}).other_id));
  if (!area || area.city_id !== c.id) return res.status(404).json({ error: "area not found" });
  if (!other || other.city_id !== c.id || other.id === area.id) return res.status(400).json({ error: "invalid other area" });

  const union = unionOutlines(outlineIds(area.id), outlineIds(other.id));
  if (!union || union.length < 3) {
    return res.status(400).json({ error: "The areas must share a boundary to merge." });
  }
  try {
    const name = ((req.body || {}).name || `${area.name} + ${other.name}`).trim();
    const neighbors = neighborAreas(c.id, union, null).filter((a) => a.id !== area.id && a.id !== other.id);
    const color = pickFromUsed(neighbors.map((a) => a.color));
    const snapped = polygonFromOutline(union.map((id) => {
      const w = db.prepare("SELECT lon AS x, lat AS y FROM waypoints WHERE id = ?").get(id);
      return { x: w.x, y: w.y };
    }));

    let newId;
    db.transaction(() => {
      const r = db
        .prepare("INSERT INTO areas (city_id, slug, name, color, polygon, share_token) VALUES (?,?,?,?,?,?)")
        .run(c.id, uniqueSlug(c.id, name), name, color, JSON.stringify(snapped), generateToken());
      newId = Number(r.lastInsertRowid);
      setOutline(newId, union);
      db.prepare("UPDATE routes SET area_id = ? WHERE area_id IN (?,?)").run(newId, area.id, other.id);
      db.prepare("DELETE FROM areas WHERE id IN (?,?)").run(area.id, other.id);
    })();
    cleanupOrphanWaypoints(c.id);
    res.status(201).json(parseArea(areaById(newId)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete an area (and its routes; orphaned waypoints are cleaned up).
app.delete("/api/cities/:city/areas/:id", (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  const area = areaById(Number(req.params.id));
  if (!area || area.city_id !== c.id) return res.status(404).json({ error: "area not found" });
  db.transaction(() => {
    db.prepare("DELETE FROM routes WHERE area_id = ?").run(area.id);
    db.prepare("DELETE FROM areas WHERE id = ?").run(area.id);
  })();
  cleanupOrphanWaypoints(c.id);
  res.json({ ok: true });
});

// Snap a coordinate to the nearest walkable road (used when placing waypoints).
app.get("/api/cities/:city/snap", async (req, res) => {
  const lon = Number(req.query.lon), lat = Number(req.query.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return res.status(400).json({ error: "lon and lat required" });
  }
  try {
    const n = await osrm.nearest({ lon, lat });
    res.json(n ? { lon: n.lon, lat: n.lat, distance_m: n.distance_m } : { lon, lat });
  } catch (e) {
    res.json({ lon, lat }); // fall back to the raw coordinate
  }
});

// Re-snap every area's boundary from its waypoints (cleans up routed nooks).
app.post("/api/cities/:city/resnap", async (req, res) => {
  const c = cityBySlug(req.params.city);
  if (!c) return res.status(404).json({ error: "city not found" });
  try {
    const rows = db.prepare("SELECT * FROM areas WHERE city_id = ?").all(c.id);
    const out = [];
    for (const area of rows) {
      const outline = getOutline(area.id);
      if (outline.length < 3) continue;
      const snapped = polygonFromOutline(outline);
      db.prepare("UPDATE areas SET polygon = ? WHERE id = ?").run(JSON.stringify(snapped), area.id);
      out.push(parseArea(areaById(area.id)));
    }
    res.json({ areas: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Routes (contributions) ------------------------------------------------
// Body: { campaign_id, waypoints?: [[lon,lat],...], drawn?: [[lon,lat],...] }
//   waypoints -> click mode: route between them directly.
//   drawn      -> freehand mode: map-match the drawn line onto streets.
app.post("/api/areas/:id/routes", async (req, res) => {
  const area = areaById(Number(req.params.id));
  if (!area) return res.status(404).json({ error: "area not found" });

  const { campaign_id, waypoints, drawn } = req.body || {};
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(Number(campaign_id));
  if (!campaign || campaign.city_id !== area.city_id) {
    return res.status(400).json({ error: "a valid campaign is required" });
  }
  try {
    let path, distance_m, unsnapped = [];

    if (waypoints && waypoints.length >= 2) {
      const coords = waypoints.map((c) => ({ lon: c[0], lat: c[1] }));
      const r = await osrm.route(coords);
      path = r.path.map((p) => [p.lon, p.lat]);
      distance_m = r.distance_m;
    } else if (drawn && drawn.length >= 2) {
      const coords = drawn.map((c) => ({ lon: c[0], lat: c[1] }));
      try {
        const m = await osrm.match(coords);
        path = m.path.map((p) => [p.lon, p.lat]);
        distance_m = m.distance_m;
      } catch (e) {
        // fallback: route through nearest points
        const snapped = [];
        for (const c of coords) {
          const n = await osrm.nearest(c);
          if (n) snapped.push({ lon: n.lon, lat: n.lat });
          else unsnapped.push([c.lon, c.lat]);
        }
        if (snapped.length < 2) return res.status(422).json({ error: "route could not be matched to streets" });
        const r = await osrm.route(snapped);
        path = r.path.map((p) => [p.lon, p.lat]);
        distance_m = r.distance_m;
      }
    } else {
      return res.status(400).json({ error: "provide at least 2 waypoints or a drawn line" });
    }

    // Simplify the recorded walking path to remove small routed nooks/crannies.
    if (Array.isArray(path) && path.length > 2) path = simplifyLine(path, SIMPLIFY_ROUTE_M);

    const lineGeom = (arr) => (Array.isArray(arr) && arr.length ? { type: "LineString", coordinates: arr } : null);
    const result = db
      .prepare(
        "INSERT INTO routes (area_id, campaign_id, waypoints, drawn, path, distance_m, unsnapped) VALUES (?,?,?,?,?,?,?)"
      )
      .run(
        area.id,
        campaign.id,
        lineGeom(waypoints) ? JSON.stringify(lineGeom(waypoints)) : null,
        lineGeom(drawn) ? JSON.stringify(lineGeom(drawn)) : null,
        JSON.stringify(lineGeom(path)),
        distance_m || null,
        unsnapped.length ? JSON.stringify(unsnapped) : null
      );
    const route = db.prepare("SELECT * FROM routes WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(parseRoute(route));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/areas/:id/routes", (req, res) => {
  const area = areaById(Number(req.params.id));
  if (!area) return res.status(404).json({ error: "area not found" });
  const rows = db.prepare("SELECT * FROM routes WHERE area_id = ? ORDER BY created_at DESC").all(area.id);
  res.json(rows.map(parseRoute));
});

// Edit a route's waypoints and re-route the walking path.
// Body: { points: [[lon,lat],...] }.
app.put("/api/routes/:id", async (req, res) => {
  const route = db.prepare("SELECT * FROM routes WHERE id = ?").get(Number(req.params.id));
  if (!route) return res.status(404).json({ error: "route not found" });
  const { points } = req.body || {};
  if (!Array.isArray(points) || points.length < 2) {
    return res.status(400).json({ error: "points (>=2) required" });
  }
  try {
    const asXY = (p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.x), Number(p.y)]);
    const coords = points.map(asXY);
    const r = await osrm.route(coords.map(([lon, lat]) => ({ lon, lat })));
    let path = r.path.map((p) => [p.lon, p.lat]);
    if (path.length > 2) path = simplifyLine(path, SIMPLIFY_ROUTE_M);
    db.prepare("UPDATE routes SET waypoints = ?, drawn = NULL, path = ?, distance_m = ?, unsnapped = NULL WHERE id = ?").run(
      JSON.stringify({ type: "LineString", coordinates: coords }),
      JSON.stringify({ type: "LineString", coordinates: path }),
      r.distance_m || null,
      route.id
    );
    res.json(parseRoute(db.prepare("SELECT * FROM routes WHERE id = ?").get(route.id)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/routes/:id", (req, res) => {
  const route = db.prepare("SELECT * FROM routes WHERE id = ?").get(Number(req.params.id));
  if (!route) return res.status(404).json({ error: "route not found" });
  db.prepare("DELETE FROM routes WHERE id = ?").run(route.id);
  res.json({ ok: true });
});

function parseRoute(r) {
  return {
    ...r,
    waypoints: r.waypoints ? JSON.parse(r.waypoints) : null,
    drawn: r.drawn ? JSON.parse(r.drawn) : null,
    path: r.path ? JSON.parse(r.path) : null,
    unsnapped: r.unsnapped ? JSON.parse(r.unsnapped) : null,
  };
}

// --- Public area page data (area + campaign scoped) -----------------------
app.get("/a/:areaToken/:campaignToken", (req, res) => {
  const area = db.prepare("SELECT * FROM areas WHERE share_token = ?").get(req.params.areaToken);
  if (!area) return res.status(404).json({ error: "area not found" });
  const campaign = db.prepare("SELECT * FROM campaigns WHERE token = ?").get(req.params.campaignToken);
  if (!campaign || campaign.city_id !== area.city_id) return res.status(404).json({ error: "campaign not found" });
  const c = cityById(area.city_id);
  const routes = db
    .prepare("SELECT * FROM routes WHERE area_id = ? AND campaign_id = ? ORDER BY created_at DESC")
    .all(area.id, campaign.id);
  // Other areas in the city (and their routes for this campaign) — shown dimmed.
  const others = db
    .prepare("SELECT * FROM areas WHERE city_id = ? AND id != ? ORDER BY name")
    .all(c.id, area.id)
    .map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      polygon: JSON.parse(a.polygon),
      routes: db
        .prepare("SELECT path FROM routes WHERE area_id = ? AND campaign_id = ?")
        .all(a.id, campaign.id)
        .map((r) => JSON.parse(r.path)),
    }));
  res.json({
    area: parseArea(area),
    campaign: { id: campaign.id, name: campaign.name },
    city: c ? { slug: c.slug, name: c.name, center: c.center ? JSON.parse(c.center) : undefined, initial_zoom: c.initial_zoom } : null,
    routes: routes.map(parseRoute),
    others,
  });
});

// Serve the built web app (production) when WEB_DIST is set, with SPA fallback.
const WEB_DIST = process.env.WEB_DIST;
if (WEB_DIST && fs.existsSync(WEB_DIST)) {
  // Hashed assets can be cached forever; index.html must always be revalidated
  // so a new deploy is picked up (mobile browsers otherwise serve a stale HTML).
  app.use(express.static(WEB_DIST, {
    setHeaders: (res) => {
      res.setHeader(
        "Cache-Control",
        res.req.path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache"
      );
    },
  }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/a/")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
}

app.use((err, req, res, _next) => {
  console.error("ERR", err);
  res.status(500).json({ error: err.message });
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

// Re-derive every area's boundary polygon from its waypoints on startup, so
// changes to the boundary algorithm take effect for existing areas. The polygon
// is a pure function of the waypoints (direct segments between them).
function resnapAllAreas() {
  const rows = db.prepare("SELECT id, polygon FROM areas").all();
  const upd = db.prepare("UPDATE areas SET polygon = ? WHERE id = ?");
  let changed = 0;
  for (const row of rows) {
    const outline = getOutline(row.id);
    if (outline.length < 3) continue;
    let json;
    try { json = JSON.stringify(polygonFromOutline(outline)); } catch { continue; }
    if (json !== row.polygon) { upd.run(json, row.id); changed++; }
  }
  if (changed) console.log(`re-snapped ${changed} area boundary(ies) from their waypoints`);
}
try { resnapAllAreas(); } catch (e) { console.error("resnapAllAreas failed:", e.message); }

app.listen(PORT, () => {
  console.log(`collabmap backend listening on http://localhost:${PORT}`);
  console.log(`admin link: http://localhost:5173/admin/${ADMIN_TOKEN}`);
});