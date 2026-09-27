// Performance seed: Voronoi-tessellates the city bbox into N areas, starts a
// campaign, and adds 10-15 routes to each area in that campaign.
// Usage: BASE=http://127.0.0.1:4345 node scripts/seed-perf.mjs

const BASE = process.env.BASE || "http://127.0.0.1:4345";
const CITY = process.env.CITY || "copenhagen";
const N_AREAS = Number(process.env.N_AREAS || 10);
const [minLon, minLat, maxLon, maxLat] = (process.env.BBOX || "12.42,55.62,12.72,55.75").split(",").map(Number);

// Deterministic RNG so runs are comparable.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(1234);
const rand = (a, b) => a + (b - a) * rng();

// ---- Voronoi (clip a box by perpendicular-bisector half-planes) ----
function clipHalfPlane(poly, nx, ny, c) {
  const out = [];
  const inside = (p) => nx * p[0] + ny * p[1] <= c + 1e-12;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    const ia = da <= 1e-12, ib = db <= 1e-12;
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}
function voronoiCell(seed, seeds) {
  let poly = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat]];
  for (const q of seeds) {
    if (q === seed) continue;
    const nx = q[0] - seed[0], ny = q[1] - seed[1];
    const c = (q[0] * q[0] + q[1] * q[1] - seed[0] * seed[0] - seed[1] * seed[1]) / 2;
    poly = clipHalfPlane(poly, nx, ny, c);
    if (poly.length < 3) break;
  }
  return poly;
}

// Jittered grid seeds for evenly-sized cells.
function makeSeeds() {
  const cols = N_AREAS <= 5 ? N_AREAS : Math.ceil(N_AREAS / 2);
  const rows = Math.ceil(N_AREAS / cols);
  const seeds = [];
  for (let r = 0; r < rows && seeds.length < N_AREAS; r++) {
    for (let c = 0; c < cols && seeds.length < N_AREAS; c++) {
      const x = minLon + (c + 0.5) / cols * (maxLon - minLon);
      const y = minLat + (r + 0.5) / rows * (maxLat - minLat);
      seeds.push([x + rand(-0.3, 0.3) / cols * (maxLon - minLon), y + rand(-0.3, 0.3) / rows * (maxLat - minLat)]);
    }
  }
  return seeds;
}

function bbox(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function samplePoint(poly) {
  const [x0, y0, x1, y1] = bbox(poly);
  for (let i = 0; i < 60; i++) {
    const p = [rand(x0, x1), rand(y0, y1)];
    if (pointInPoly(p, poly)) return p;
  }
  return poly[0];
}

async function post(path, body) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function main() {
  const seeds = makeSeeds();
  console.log(`Voronoi: ${seeds.length} seeds over bbox [${minLon},${minLat},${maxLon},${maxLat}]`);

  // 1. Create areas from Voronoi cells.
  const tA = performance.now();
  const areas = [];
  for (let i = 0; i < seeds.length; i++) {
    const cell = voronoiCell(seeds[i], seeds);
    if (cell.length < 3) continue;
    const outline = cell.map(([x, y]) => ({ x, y }));
    const area = await post(`/api/cities/${CITY}/areas`, { name: `Zone ${i + 1}`, outline });
    areas.push({ ...area, cell });
  }
  const areaMs = performance.now() - tA;
  console.log(`Created ${areas.length} areas in ${areaMs.toFixed(0)} ms (${(areaMs / areas.length).toFixed(0)} ms/area)`);

  // 2. Campaign.
  const campaign = await post(`/api/cities/${CITY}/campaigns`, { name: `Perf ${new Date().toISOString().slice(0, 16)}` });
  console.log(`Campaign: ${campaign.name} (token ${campaign.token})`);

  // 3. Routes per area.
  let total = 0, ok = 0, failed = 0;
  const routeTimes = [];
  const tR = performance.now();
  for (const area of areas) {
    const n = 10 + Math.floor(rng() * 6); // 10..15
    for (let k = 0; k < n; k++) {
      total++;
      const wpc = 2 + Math.floor(rng() * 3); // 2..4 waypoints
      const waypoints = [];
      for (let w = 0; w < wpc; w++) waypoints.push(samplePoint(area.cell));
      const t0 = performance.now();
      try {
        await post(`/api/areas/${area.id}/routes`, { campaign_id: campaign.id, waypoints });
        ok++;
      } catch {
        failed++;
      }
      routeTimes.push(performance.now() - t0);
    }
  }
  const routeMs = performance.now() - tR;
  routeTimes.sort((a, b) => a - b);
  const avg = routeTimes.reduce((s, x) => s + x, 0) / routeTimes.length;
  const p95 = routeTimes[Math.floor(routeTimes.length * 0.95)] || 0;

  console.log(`\nRoutes: ${ok}/${total} created (${failed} failed) in ${(routeMs / 1000).toFixed(1)} s`);
  console.log(`  ${(routeMs / total).toFixed(0)} ms/route avg wall, p50 ${routeTimes[Math.floor(routeTimes.length / 2)].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
  console.log(`  total requests: ${total}, avg RPC ${avg.toFixed(0)} ms`);
  console.log(`\nDone. Areas: ${areas.length}, campaign id ${campaign.id}, routes: ${ok}`);
}

main().catch((e) => { console.error("SEED FAILED:", e.message); process.exit(1); });
