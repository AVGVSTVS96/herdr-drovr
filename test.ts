#!/usr/bin/env node
import assert from "node:assert";
import { test } from "node:test";
import { rootFromFlatSnapshot, anchorOf, leavesOf } from "./pick-and-move.ts";
import type { Rect, LayoutSnapshot, SnapshotPane, SplitNode } from "./pick-and-move.ts";

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const pane = (pane_id: string, r: Rect): SnapshotPane => ({ pane_id, rect: r, focused: false });

test("a tab with a single pane and no splits reconstructs as that pane", () => {
  const snap: LayoutSnapshot = { area: rect(0, 0, 100, 50), panes: [pane("p1", rect(0, 0, 100, 50))], splits: [] };
  assert.deepStrictEqual(rootFromFlatSnapshot(snap), { type: "pane", pane_id: "p1" });
});

test("split boundaries come from reported rects, not ratio arithmetic: 101 wide at ratio 0.5, server boundary at 50 while Math.round gives 51", () => {
  const snap: LayoutSnapshot = {
    area: rect(0, 0, 101, 40),
    panes: [pane("a", rect(0, 0, 50, 40)), pane("b", rect(50, 0, 51, 40))],
    splits: [{ direction: "right", ratio: 0.5, rect: rect(0, 0, 101, 40) }],
  };
  const root = rootFromFlatSnapshot(snap);
  assert.strictEqual(root.type, "split");
  assert.deepStrictEqual(leavesOf(root), ["a", "b"]);
});

test("nested splits with mixed directions reconstruct the full tree", () => {
  const snap: LayoutSnapshot = {
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
});

test("a nested split on the second side picks the larger rect when a grandchild shares the parent's far edge", () => {
  const snap: LayoutSnapshot = {
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
  assert.strictEqual((root as SplitNode).second.type, "split");
});

test("a pane missing from the snapshot throws instead of misbuilding", () => {
  const snap: LayoutSnapshot = {
    area: rect(0, 0, 100, 40),
    panes: [pane("a", rect(0, 0, 50, 40))],
    splits: [{ direction: "right", ratio: 0.5, rect: rect(0, 0, 100, 40) }],
  };
  assert.throws(() => rootFromFlatSnapshot(snap), /could not find the second child/);
});

test("a malformed snapshot throws", () => {
  assert.throws(() => rootFromFlatSnapshot({} as LayoutSnapshot), /missing area\/panes\/splits/);
});
