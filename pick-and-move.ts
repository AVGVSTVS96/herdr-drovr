#!/usr/bin/env node
// Overlay picker (fzf needs the pane's TTY) plus a detached mover pass:
// herdr no-ops any `pane move` out of a tab that still hosts the overlay, so
// the picker writes a plan, respawns itself detached (TAB_MOVER_PLAN), and
// exits to release the tab.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const HB = process.env.HERDR_BIN_PATH || "herdr";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SplitDirection = "right" | "down";

export interface PaneNode {
  type: "pane";
  pane_id: string;
}

export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

// Flat snapshot as reported by `herdr pane layout`.
export interface SnapshotPane {
  pane_id: string;
  rect: Rect;
  focused: boolean;
}

export interface SnapshotSplit {
  direction: SplitDirection;
  ratio: number;
  rect: Rect;
}

export interface LayoutSnapshot {
  area: Rect;
  panes: SnapshotPane[];
  splits: SnapshotSplit[];
}

export interface JobSnapshot extends LayoutSnapshot {
  tab_id: string;
  workspace_id: string;
}

interface PaneListResult {
  panes: { pane_id: string; tab_id: string; focused: boolean }[];
}

interface TabListResult {
  tabs: { tab_id: string; label?: string }[];
}

interface WorkspaceListResult {
  workspaces: { workspace_id: string; label?: string }[];
}

interface MovedPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}

interface MoveResult {
  changed: boolean;
  pane: MovedPane;
}

interface PaneMoveResult {
  move_result: MoveResult;
}

type MovePlan =
  | { root: LayoutNode; tabLabel: string; toNewWorkspace: true }
  | { root: LayoutNode; tabLabel: string; toNewWorkspace: false; destWs: string };

function herdrJSON<T>(args: string[]): { result: T } {
  const r = spawnSync(HB, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return JSON.parse(r.stdout) as { result: T };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function keepOverlayOpenUntilEnter(msg: string): void {
  process.stderr.write(`\n${msg}\n[enter] `);
  try {
    fs.readSync(0, Buffer.alloc(64));
  } catch {}
}

function rectEq(a: Rect, b: Rect): boolean {
  return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// The rect flush against `area`'s far edge, spanning the full cross dimension.
// Nested descendants on that side match the same edges but are strictly
// smaller, so the largest match is the split's second child.
function secondChildRect(rects: Rect[], area: Rect, direction: SplitDirection): Rect {
  const fits =
    direction === "right"
      ? (r: Rect) => r.y === area.y && r.height === area.height && r.x > area.x && r.x + r.width === area.x + area.width
      : (r: Rect) => r.x === area.x && r.width === area.width && r.y > area.y && r.y + r.height === area.y + area.height;
  let best: Rect | null = null;
  for (const r of rects) {
    if (fits(r) && (!best || r.width * r.height > best.width * best.height)) best = r;
  }
  if (!best) {
    throw new Error(`could not find the second child of the ${direction} split at ${JSON.stringify(area)}`);
  }
  return best;
}

// Child rects are looked up among the rects Herdr actually reported, never
// derived via ratio arithmetic, so rounding can't desynchronize us from the server.
function rootFromFlatSnapshot(snapshot: LayoutSnapshot): LayoutNode {
  if (!snapshot || !snapshot.area || !Array.isArray(snapshot.panes) || !Array.isArray(snapshot.splits)) {
    throw new Error("layout snapshot is missing area/panes/splits");
  }
  const rects = [...snapshot.panes, ...snapshot.splits].map((e) => e.rect);

  function build(area: Rect): LayoutNode {
    const split = snapshot.splits.find((s) => rectEq(s.rect, area));
    if (!split) {
      const pane = snapshot.panes.find((p) => rectEq(p.rect, area));
      if (!pane) {
        throw new Error(`could not map layout area to a pane or split: ${JSON.stringify(area)}`);
      }
      return { type: "pane", pane_id: pane.pane_id };
    }
    const second = secondChildRect(rects, area, split.direction);
    const first =
      split.direction === "right"
        ? { x: area.x, y: area.y, width: second.x - area.x, height: area.height }
        : { x: area.x, y: area.y, width: area.width, height: second.y - area.y };
    return {
      type: "split",
      direction: split.direction,
      ratio: split.ratio,
      first: build(first),
      second: build(second),
    };
  }

  return build(snapshot.area);
}

function anchorOf(node: LayoutNode): string {
  return node.type === "pane" ? node.pane_id : anchorOf(node.first);
}

function leavesOf(node: LayoutNode, out: string[] = []): string[] {
  if (node.type === "pane") out.push(node.pane_id);
  else {
    leavesOf(node.first, out);
    leavesOf(node.second, out);
  }
  return out;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `pane move` exits 0 but reports `changed: false` while the source tab is
// still pinned by the closing picker overlay; retry until the move takes.
function moveUntilChanged(args: string[], tries = 40): MoveResult {
  for (let i = 0; i < tries; i++) {
    const r = herdrJSON<PaneMoveResult>(args).result.move_result;
    if (r.changed) return r;
    sleepMs(50);
  }
  throw new Error(`move kept getting refused: herdr ${args.join(" ")}`);
}

function executeMovePlan(planPath: string): void {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as MovePlan;
  const { root, tabLabel } = plan;
  fs.unlinkSync(planPath);

  const rootAnchor = anchorOf(root);
  const createDestinationTabArgs = plan.toNewWorkspace
    ? ["pane", "move", rootAnchor, "--new-workspace", "--label", tabLabel, "--tab-label", tabLabel, "--no-focus"]
    : ["pane", "move", rootAnchor, "--new-tab", "--workspace", plan.destWs, "--label", tabLabel, "--no-focus"];
  const first = moveUntilChanged(createDestinationTabArgs);
  const newTab = first.pane.tab_id;
  const idMap: Record<string, string> = { [rootAnchor]: first.pane.pane_id };

  // Focus the destination now: the user watches it assemble while the source
  // dismantles off-screen. Pane moves stay --no-focus so focus jumps exactly once.
  herdrJSON(["workspace", "focus", first.pane.workspace_id]);
  herdrJSON(["tab", "focus", newTab]);

  // For each split, carve the SECOND region out of the pane currently filling
  // the node's region (the anchor of FIRST), then recurse. Herdr's --ratio is
  // the fraction retained by the target (first) pane, which is exactly
  // SplitNode.ratio; directions ("right"/"down") map 1:1.
  function place(node: LayoutNode): void {
    if (node.type === "pane") return;
    const target = idMap[anchorOf(node)];
    if (!target) {
      throw new Error(`internal: anchor ${anchorOf(node)} was never placed`);
    }
    const secondOld = anchorOf(node.second);
    const resp = moveUntilChanged([
      "pane", "move", secondOld,
      "--tab", newTab,
      "--split", node.direction,
      "--target-pane", target,
      "--ratio", String(node.ratio),
      "--no-focus",
    ]);
    idMap[secondOld] = resp.pane.pane_id;
    place(node.first);
    place(node.second);
  }
  place(root);
}

// A failed label lookup falls back silently: the move matters more than the name.
function sourceTabLabel(srcTab: string): string {
  try {
    const tab = herdrJSON<TabListResult>(["tab", "list"]).result.tabs.find((t) => t.tab_id === srcTab);
    if (tab && tab.label) return tab.label;
  } catch {}
  return "moved";
}

function sourceTabStillIntact(root: LayoutNode, srcTab: string): boolean {
  const live = new Map(herdrJSON<PaneListResult>(["pane", "list"]).result.panes.map((p) => [p.pane_id, p.tab_id]));
  return leavesOf(root).every((id) => live.get(id) === srcTab);
}

const FZF_NO_MATCH = 1;
const FZF_CANCELLED = 130;

function main(): number {
  const jobPath = process.env.TAB_MOVER_JOB;
  let snapshot: JobSnapshot;
  try {
    if (!jobPath) throw new Error("TAB_MOVER_JOB is not set");
    snapshot = JSON.parse(fs.readFileSync(jobPath, "utf8")) as JobSnapshot;
    fs.unlinkSync(jobPath);
  } catch {
    keepOverlayOpenUntilEnter("tab-mover: no pending job (run the move-tab action, not this pane directly).");
    return 1;
  }

  let root: LayoutNode;
  try {
    root = rootFromFlatSnapshot(snapshot);
  } catch (err) {
    keepOverlayOpenUntilEnter(`tab-mover: could not reconstruct source layout: ${errorMessage(err)}`);
    return 1;
  }
  const srcTab = snapshot.tab_id;
  const srcWs = snapshot.workspace_id;
  const tabLabel = sourceTabLabel(srcTab);

  const destinations = herdrJSON<WorkspaceListResult>(["workspace", "list"]).result.workspaces.filter(
    (w) => w.workspace_id !== srcWs
  );
  const NEW_LABEL = "＋ new workspace";
  const lines = [
    NEW_LABEL,
    ...destinations.map((w) => `${w.label || w.workspace_id}\t${w.workspace_id}`),
  ].join("\n");

  // fzf draws on /dev/tty, leaving stdin/stdout free for candidates and the
  // pick; --with-nth=1 hides the tab-delimited workspace id column.
  const fzf = spawnSync(
    "fzf",
    [
      "--prompt", "move tab to › ",
      "--header", "type to filter · enter moves · esc cancels",
      "--delimiter", "\t",
      "--with-nth", "1",
      "--height", "100%",
    ],
    { input: lines, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }
  );
  if (fzf.error) {
    keepOverlayOpenUntilEnter("tab-mover: fzf not found on PATH.");
    return 1;
  }
  if (fzf.status === FZF_NO_MATCH || fzf.status === FZF_CANCELLED) return 0;
  if (fzf.status !== 0) {
    keepOverlayOpenUntilEnter(`tab-mover: fzf exited with status ${fzf.status}.`);
    return 1;
  }
  const choice = (fzf.stdout || "").trim();
  if (!choice) return 0;

  if (!sourceTabStillIntact(root, srcTab)) {
    keepOverlayOpenUntilEnter("tab-mover: the source tab changed while the picker was open; nothing was moved.");
    return 1;
  }

  let plan: MovePlan;
  if (choice === NEW_LABEL) {
    plan = { root, tabLabel, toNewWorkspace: true };
  } else {
    const destWs = choice.split("\t")[1];
    if (!destWs) {
      keepOverlayOpenUntilEnter(`tab-mover: could not parse the picked workspace: ${JSON.stringify(choice)}`);
      return 1;
    }
    plan = { root, tabLabel, toNewWorkspace: false, destWs };
  }
  const planPath = jobPath.replace("job-", "plan-");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  spawnDetachedMover(planPath);
  return 0;
}

function spawnDetachedMover(planPath: string): void {
  spawn(process.execPath, [import.meta.filename], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TAB_MOVER_PLAN: planPath },
  }).unref();
}

export { rootFromFlatSnapshot, secondChildRect, anchorOf, leavesOf };

if (process.argv[1] === import.meta.filename) {
  if (process.env.TAB_MOVER_PLAN) {
    try {
      executeMovePlan(process.env.TAB_MOVER_PLAN);
    } catch (err) {
      spawnSync(HB, ["notification", "show", "tab-mover: move failed", "--body", errorMessage(err)]);
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    process.exit(main());
  } catch (err) {
    keepOverlayOpenUntilEnter(`tab-mover: ${errorMessage(err)}`);
    process.exit(1);
  }
}
