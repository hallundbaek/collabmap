// Unit tests for polygon splitting. Run: node server/geo.test.mjs
import assert from "node:assert";
import { splitRing, openRing } from "./geo.js";

const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
const hasAll = (ring, verts) => verts.every((v) => openRing(ring).some((p) => same(p, v)));
const hasNone = (ring, verts) => verts.every((v) => !openRing(ring).some((p) => same(p, v)));

// Square ring, counter-clockwise.
const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
const v0 = [0, 0], v1 = [10, 0], v2 = [10, 10], v3 = [0, 10];

// Divide from edge v0-v1 to edge v2-v3 (vertical cut): right half keeps v1,v2.
{
  const [r1, r2] = splitRing(ring, [[5, 0], [5, 10]]);
  assert(hasAll(r1, [v1, v2]) && hasNone(r1, [v0, v3]), "vertical: r1 should be right half (v1,v2)");
  assert(hasAll(r2, [v0, v3]) && hasNone(r2, [v1, v2]), "vertical: r2 should be left half (v0,v3)");
}

// Divide from edge v1-v2 to edge v3-v0 (horizontal cut): top half keeps v2,v3.
{
  const [r1, r2] = splitRing(ring, [[10, 5], [0, 5]]);
  assert(hasAll(r1, [v2, v3]) && hasNone(r1, [v0, v1]), "horizontal: r1 should be top half (v2,v3)");
  assert(hasAll(r2, [v0, v1]) && hasNone(r2, [v2, v3]), "horizontal: r2 should be bottom half (v0,v1)");
}

// Both endpoints on the same pair of adjacent edges, with an interior divide point.
{
  const [r1, r2] = splitRing(ring, [[5, 0], [5, 5], [5, 10]]);
  assert(hasAll(r1, [v1, v2]) && hasAll(r2, [v0, v3]), "3-point divide halves");
  assert(openRing(r1).some((p) => same(p, [5, 5])), "interior point in r1");
  assert(openRing(r2).some((p) => same(p, [5, 5])), "interior point in r2");
}

// Every original vertex goes to exactly one half (no loss, no duplication).
{
  const [r1, r2] = splitRing(ring, [[2, 0], [8, 10]]);
  const all = [...openRing(r1), ...openRing(r2)];
  for (const v of [v0, v1, v2, v3]) {
    const count = all.filter((p) => same(p, v)).length;
    assert.strictEqual(count, 1, `vertex ${v} must appear exactly once across halves`);
  }
}

console.log("geo.test.mjs: all splitRing tests passed");
