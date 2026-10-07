import Database from "better-sqlite3";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dataDir = process.env.DATA_DIR || path.join(root, "data");
const dbPath = path.join(dataDir, "collabmap.db");
const citiesJson = process.env.CITIES_FILE || path.join(__dirname, "cities.json");

import { mkdirSync } from "node:fs";
mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export const schema = db.exec(`
  CREATE TABLE IF NOT EXISTS cities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    bbox       TEXT NOT NULL,
    center     TEXT,
    initial_zoom REAL
  );

  CREATE TABLE IF NOT EXISTS areas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    city_id       INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    slug          TEXT NOT NULL,
    name          TEXT NOT NULL,
    color         TEXT,
    polygon       TEXT NOT NULL,              -- GeoJSON Polygon (edges snapped to streets)
    share_token   TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(city_id, slug)
  );

  -- Global waypoints per city. A waypoint may be shared by several areas.
  CREATE TABLE IF NOT EXISTS waypoints (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    city_id  INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    lon      REAL NOT NULL,
    lat      REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_waypoints_city ON waypoints(city_id);

  -- Each area's outline: an ordered list of waypoint ids (open ring).
  CREATE TABLE IF NOT EXISTS area_waypoints (
    area_id     INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    waypoint_id INTEGER NOT NULL REFERENCES waypoints(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (area_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_aw_waypoint ON area_waypoints(waypoint_id);
  CREATE INDEX IF NOT EXISTS idx_aw_area ON area_waypoints(area_id);

  -- A campaign groups route-collection for a city; each (area, campaign) has a link.
  CREATE TABLE IF NOT EXISTS campaigns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    city_id    INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_city ON campaigns(city_id);

  CREATE TABLE IF NOT EXISTS routes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id       INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    campaign_id   INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    waypoints     TEXT,                        -- GeoJSON LineString (clicked), nullable
    drawn         TEXT,                        -- GeoJSON LineString (freehand), nullable
    path          TEXT NOT NULL,               -- GeoJSON LineString (snapped walking path)
    distance_m    REAL,
    unsnapped     TEXT                          -- GeoJSON list of points that failed to snap
  );

  CREATE INDEX IF NOT EXISTS idx_areas_city ON areas(city_id);
  CREATE INDEX IF NOT EXISTS idx_routes_area ON routes(area_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migration for databases created before the waypoints tables existed.
try { db.exec("SELECT 1 FROM waypoints LIMIT 1"); } catch {
  db.exec(`
    CREATE TABLE waypoints (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id  INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      lon      REAL NOT NULL,
      lat      REAL NOT NULL
    );
    CREATE INDEX idx_waypoints_city ON waypoints(city_id);
    CREATE TABLE area_waypoints (
      area_id     INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
      waypoint_id INTEGER NOT NULL REFERENCES waypoints(id) ON DELETE CASCADE,
      seq         INTEGER NOT NULL,
      PRIMARY KEY (area_id, seq)
    );
    CREATE INDEX idx_aw_waypoint ON area_waypoints(waypoint_id);
    CREATE INDEX idx_aw_area ON area_waypoints(area_id);
  `);
}
// Drop the now-unused inline waypoints column (SQLite >= 3.35).
try { db.exec("ALTER TABLE areas DROP COLUMN waypoints"); } catch (e) { /* column absent or unsupported */ }

// Add the color column used to distinguish neighbouring areas.
const areaCols2 = db.prepare("PRAGMA table_info(areas)").all().map((c) => c.name);
if (!areaCols2.includes("color")) {
  db.exec("ALTER TABLE areas ADD COLUMN color TEXT");
}

// Add campaign scoping to routes (existing routes get NULL campaign).
const routeCols = db.prepare("PRAGMA table_info(routes)").all().map((c) => c.name);
if (!routeCols.includes("campaign_id")) {
  db.exec("ALTER TABLE routes ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE");
}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_routes_campaign ON routes(campaign_id)"); } catch (e) { /* ignore */ }

// Short, URL-safe link tokens (8 hex characters).
export function generateToken() {
  return crypto.randomBytes(4).toString("hex");
}

export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// Shorten any existing longer tokens to 8 characters (keeps links short).
function shortenTokens(table, col) {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE length(${col}) != 8`).all();
  if (!rows.length) return;
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ?`);
  const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) {
      let t;
      do { t = generateToken(); } while (exists.get(t));
      upd.run(t, r.id);
    }
  })();
}
shortenTokens("areas", "share_token");
shortenTokens("campaigns", "token");

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "area";
}

// Sync cities from cities.json on startup (idempotent by slug): new cities are
// added and existing ones refreshed, so editing cities.json takes effect without
// wiping the database.
export function ensureDefaultCities() {
  const list = JSON.parse(readFileSync(citiesJson, "utf8"));
  const ins = db.prepare(`
    INSERT INTO cities (slug, name, bbox, center, initial_zoom)
    VALUES (@slug, @name, @bbox, @center, @initial_zoom)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      bbox = excluded.bbox,
      center = excluded.center,
      initial_zoom = excluded.initial_zoom
  `);
  const tx = db.transaction(() => {
    for (const c of list) {
      ins.run({
        slug: c.slug,
        name: c.name,
        bbox: JSON.stringify(c.bbox),
        center: JSON.stringify(c.initial_center),
        initial_zoom: c.initial_zoom,
      });
    }
    // Remove cities no longer listed, but never delete one that still has areas.
    if (list.length) {
      const ph = list.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM cities WHERE slug NOT IN (${ph}) AND id NOT IN (SELECT DISTINCT city_id FROM areas)`
      ).run(...list.map((c) => c.slug));
    }
  });
  tx();
}

export { db, slugify };

export default db;