import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/lib/engine/graph";
import type { LonLat } from "../src/lib/engine/types";

// Made-up streets.
const line = (keys: string[], coords: LonLat[], oneway = 0) => ({ name: keys[0], keys, coords, oneway });

test("a divided road's one-way carriageways are not bridged across the median", () => {
  // Eastbound and westbound carriageways 15 m apart, each a chain of points.
  const east: LonLat[] = [];
  const west: LonLat[] = [];
  for (let i = 0; i <= 10; i++) {
    east.push([-78.8 + i * 0.0006, 35.8]);
    west.push([-78.8 + (10 - i) * 0.0006, 35.80014]);
  }
  const graph = buildGraph([line(["maple pkwy"], east, 1), line(["maple pkwy"], west, 1)]);
  assert.equal(graph.edges.filter((e) => e.synthetic === "same-road-gap").length, 0);
});

test("a real gap in a one-way road is bridged only in its direction", () => {
  const first: LonLat[] = [[-78.8, 35.8], [-78.799, 35.8]];
  const second: LonLat[] = [[-78.798, 35.8], [-78.797, 35.8]];
  const graph = buildGraph([line(["maple pkwy"], first, 1), line(["maple pkwy"], second, 1)]);
  const bridges = graph.edges.filter((e) => e.synthetic === "same-road-gap");
  assert.equal(bridges.length, 1);
  assert.ok(bridges[0].coords[0][0] < bridges[0].coords[1][0], "the bridge runs east, with the road");
});

test("streets the sheet joins get a junction where they cross without a shared point", () => {
  const ns = line(["elm st"], [[-78.8, 35.799], [-78.8, 35.801]]);
  const ew = line(["oak ave"], [[-78.801, 35.8], [-78.799, 35.8]]);
  const shared = (g: ReturnType<typeof buildGraph>) =>
    [...g.nodes.values()].some((n) => n.out.some((e) => e.keys.includes("elm st")) && n.out.some((e) => e.keys.includes("oak ave")));
  assert.equal(shared(buildGraph([ns, ew])), false, "an unlisted crossing may be an overpass");
  assert.equal(shared(buildGraph([ns, ew], undefined, new Set(["elm st|oak ave"]))), true);
});
