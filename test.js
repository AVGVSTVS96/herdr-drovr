#!/usr/bin/env node
// Unit tests for the layout-tree reconstruction in pick-and-move.js.

"use strict";
const assert = require("node:assert");
const { rootFromFlatSnapshot, anchorOf, leavesOf } = require("./pick-and-move.js");

const rect = (x, y, width, height) => ({ x, y, width, height });
const pane = (pane_id, r) => ({ pane_id, rect: r, focused: false });

// single pane: no splits, root is the pane itself
{
  const snap = { area: rect(0, 0, 100, 50), panes: [pane("p1", rect(0, 0, 100, 50))], splits: [] };
  const root = rootFromFlatSnapshot(snap);
  assert.deepStrictEqual(root, { type: "pane", pane_id: "p1" });
}

// rounding regression: 101 wide, ratio 0.5, server put the boundary at 50.
// Math.round(101 * 0.5) = 51 would have missed both pane rects; rect search
// must not care.
{
  const snap = {
    area: rect(0, 0, 101, 40),
    panes: [pane("a", rect(0, 0, 50, 40)), pane("b", rect(50, 0, 51, 40))],
    splits: [{ direction: "right", ratio: 0.5, rect: rect(0, 0, 101, 40) }],
  };
  const root = rootFromFlatSnapshot(snap);
  assert.strictEqual(root.type, "split");
  assert.deepStrictEqual(leavesOf(root), ["a", "b"]);
}

// nested mixed directions: right split whose first half is split down
{
  const snap = {
    area: rect(0, 0, 100, 60),
    panes: [
      pane("a1", rect(0, 0, 60, 30)),
      pane("a2", rect(0, 30, 60, 30)),
      pane("b", rect(60, 0, 40, 60)),
    ],
    splits: [
      { direction: "right", ratio: 0.6, rect: rect(0, 0, 100, 60) },
      { direction: "down", ratio: 0.5, rect: rect(0, 0, 60, 60) },
    ],
  };
  const root = rootFromFlatSnapshot(snap);
  assert.deepStrictEqual(root, {
    type: "split",
    direction: "right",
    ratio: 0.6,
    first: {
      type: "split",
      direction: "down",
      ratio: 0.5,
      first: { type: "pane", pane_id: "a1" },
      second: { type: "pane", pane_id: "a2" },
    },
    second: { type: "pane", pane_id: "b" },
  });
  assert.strictEqual(anchorOf(root), "a1");
  assert.deepStrictEqual(leavesOf(root), ["a1", "a2", "b"]);
}

// nested split on the SECOND side: b2 shares the far edge and full height
// with its parent b, so the child search must pick the larger rect (b).
{
  const snap = {
    area: rect(0, 0, 100, 40),
    panes: [
      pane("a", rect(0, 0, 40, 40)),
      pane("b1", rect(40, 0, 30, 40)),
      pane("b2", rect(70, 0, 30, 40)),
    ],
    splits: [
      { direction: "right", ratio: 0.4, rect: rect(0, 0, 100, 40) },
      { direction: "right", ratio: 0.5, rect: rect(40, 0, 60, 40) },
    ],
  };
  const root = rootFromFlatSnapshot(snap);
  assert.deepStrictEqual(leavesOf(root), ["a", "b1", "b2"]);
  assert.strictEqual(root.second.type, "split");
}

// unmappable area (pane missing from snapshot) must throw, not misbuild
{
  const snap = {
    area: rect(0, 0, 100, 40),
    panes: [pane("a", rect(0, 0, 50, 40))],
    splits: [{ direction: "right", ratio: 0.5, rect: rect(0, 0, 100, 40) }],
  };
  assert.throws(() => rootFromFlatSnapshot(snap), /could not find the second child/);
}

// malformed snapshot must throw
assert.throws(() => rootFromFlatSnapshot({}), /missing area\/panes\/splits/);

console.log("test.js: all layout reconstruction tests passed");
