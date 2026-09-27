// Pure polygon geometry helpers (no network). Used for splitting and snapping
// points onto a boundary ring.

function sqDist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function samePoint(a, b, eps = 1e-9) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

// Distance from point p to segment [a, b].
function pointToSegDist(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.sqrt(sqDist(p, a));
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt(sqDist(p, [a[0] + t * abx, a[1] + t * aby]));
}

// Closest point on segment [a, b] to point p, plus its parameter t in [0,1].
function projectOnSeg(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { pt: [a[0], a[1]], t: 0 };
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return { pt: [a[0] + t * abx, a[1] + t * aby], t };
}

// Snap a point onto a boundary ring (an open array of vertices, no closing dup).
// Returns { vi, t, pt }: vi = index of the nearest segment's first vertex, t =
// position along that segment, pt = the projected point on the boundary.
export function snapPointToRing(ring, p) {
  let bestVi = 0;
  let bestT = 0;
  let bestPt = [...ring[0]];
  let bestDist = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const d = pointToSegDist(p, a, b);
    if (d < bestDist) {
      const proj = projectOnSeg(p, a, b);
      bestDist = d;
      bestVi = i;
      bestT = proj.t;
      bestPt = proj.pt;
    }
  }
  return { vi: bestVi, t: bestT, pt: bestPt };
}

// Build a ring with snapped points inserted in the right place. Multiple points
// on the same segment are ordered by their position along it. Returns the new
// point list plus the exact indices of the inserted points (by key).
function buildRingWithSnaps(ring, snaps) {
  const byVi = new Map();
  for (const s of snaps) {
    const arr = byVi.get(s.vi) || [];
    arr.push(s);
    byVi.set(s.vi, arr);
  }
  for (const arr of byVi.values()) arr.sort((x, y) => x.t - y.t);

  const pts = [];
  const idx = {};
  for (let i = 0; i < ring.length; i++) {
    pts.push(ring[i]);
    const arr = byVi.get(i);
    if (arr) {
      for (const s of arr) {
        pts.push(s.pt);
        idx[s.key] = pts.length - 1;
      }
    }
  }
  return { pts, ia: idx.a, ib: idx.b };
}

// Split an open boundary ring with an interior dividing polyline.
// divPts: [[lon,lat],...] with endpoints near the boundary.
// Returns [ring1Closed, ring2Closed], each a closed ring (first == last).
export function splitRing(ring, divPts) {
  if (ring.length < 3) throw new Error("ring too small to split");
  if (divPts.length < 2) throw new Error("dividing line needs at least 2 points");

  const a = snapPointToRing(ring, divPts[0]);
  const b = snapPointToRing(ring, divPts[divPts.length - 1]);

  // Insert both projected points correctly (independent of insertion order).
  const { pts, ia, ib } = buildRingWithSnaps(ring, [
    { key: "a", vi: a.vi, t: a.t, pt: a.pt },
    { key: "b", vi: b.vi, t: b.t, pt: b.pt },
  ]);
  if (ia === ib) throw new Error("dividing line endpoints meet at the same boundary point");

  const sliceAB = ia <= ib ? pts.slice(ia, ib + 1) : pts.slice(ia).concat(pts.slice(0, ib + 1));
  const sliceBA = ib <= ia ? pts.slice(ib, ia + 1) : pts.slice(ib).concat(pts.slice(0, ia + 1));

  const interior = divPts.slice(1, divPts.length - 1);
  const revInterior = interior.slice().reverse();

  const ring1 = sliceAB.concat(revInterior).concat([sliceAB[0]]);
  const ring2 = sliceBA.concat(interior).concat([sliceBA[0]]);

  return [ring1, ring2];
}

// Remove the closing duplicate if present.
export function openRing(ring) {
  if (ring.length >= 2 && samePoint(ring[0], ring[ring.length - 1])) return ring.slice(0, -1);
  return ring.slice();
}

// ---- Simplification (removes routed nooks/crannies) ----------------------
const M_PER_DEG = 111320; // metres per degree of latitude

function pointToSegMeters(p, a, b) {
  const latRef = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const mPerLon = M_PER_DEG * Math.cos(latRef);
  const ax = a[0] * mPerLon, ay = a[1] * M_PER_DEG;
  const bx = b[0] * mPerLon, by = b[1] * M_PER_DEG;
  const px = p[0] * mPerLon, py = p[1] * M_PER_DEG;
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

// Douglas-Peucker on an open polyline, tolerance in metres. End points kept.
export function simplifyLine(points, tolMeters) {
  if (!Array.isArray(points) || points.length < 3) return points ? points.slice() : [];
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointToSegMeters(points[i], points[s], points[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolMeters && idx > s) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Simplify a closed ring (open array, no closing duplicate). Anchors on the
// point farthest from the first vertex so both halves simplify cleanly.
export function simplifyRing(ring, tolMeters) {
  const pts = openRing(ring);
  if (pts.length <= 3) return pts;
  let far = 0, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = sqDist(pts[i], pts[0]);
    if (d > best) { best = d; far = i; }
  }
  if (far === 0) return pts;
  const half1 = simplifyLine(pts.slice(0, far + 1), tolMeters);
  const half2 = simplifyLine(pts.slice(far).concat([pts[0]]), tolMeters);
  const out = half1.slice(0, -1).concat(half2.slice(0, -1));
  return out.length >= 3 ? out : pts;
}