#!/usr/bin/env node
// Picker (fzf needs the pane's TTY) plus a detached mover pass. On herdr
// <= 0.7.3 the picker is an overlay pane inside the source tab, and herdr
// no-ops any `pane move` out of a tab that still hosts the overlay, so the
// picker writes a plan, respawns itself detached (DROVR_PLAN), and exits to
// release the tab. On >= 0.7.4 the picker floats as a popup and nothing is
// pinned, but the detached pass works identically there, so it stays the
// single execution path.

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

export type Job =
  | ({ mode: "tab" } & JobSnapshot)
  | { mode: "pane"; pane_id: string; tab_id: string; workspace_id: string };

export interface TabEntry {
  tab_id: string;
  workspace_id: string;
  label?: string;
}

export interface WorkspaceEntry {
  workspace_id: string;
  label?: string;
}

interface PaneListResult {
  panes: { pane_id: string; tab_id: string; focused: boolean }[];
}

interface TabListResult {
  tabs: TabEntry[];
}

interface WorkspaceListResult {
  workspaces: WorkspaceEntry[];
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

export type PaneDest =
  | { kind: "tab"; tabId: string }
  | { kind: "new-tab" }
  | { kind: "new-workspace" };

type MovePlan =
  | { mode: "tab"; root: LayoutNode; tabLabel: string; toNewWorkspace: true }
  | { mode: "tab"; root: LayoutNode; tabLabel: string; toNewWorkspace: false; destWs: string }
  | { mode: "pane"; paneId: string; srcWs: string; direction: SplitDirection; dest: PaneDest };

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

function keepPickerOpenUntilEnter(msg: string): void {
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

export const NEW_TAB_TOKEN = "new-tab";
export const NEW_WS_TOKEN = "new-ws";

// Candidate lines for the pane picker: sentinels first, then destination tabs
// (source tab excluded, source-workspace tabs first). Column 2 carries the
// machine token; fzf hides it via --with-nth=1.
function paneDestLines(
  tabs: TabEntry[],
  workspaces: WorkspaceEntry[],
  srcTabId: string,
  srcWsId: string,
  all: boolean
): string[] {
  const wsLabel = new Map(workspaces.map((w) => [w.workspace_id, w.label || w.workspace_id]));
  const eligible = tabs.filter((t) => t.tab_id !== srcTabId && (all || t.workspace_id === srcWsId));
  const ordered = [
    ...eligible.filter((t) => t.workspace_id === srcWsId),
    ...eligible.filter((t) => t.workspace_id !== srcWsId),
  ];
  const rows = ordered.map((t) => {
    const name = t.label || t.tab_id;
    const shown = t.workspace_id === srcWsId ? name : `${wsLabel.get(t.workspace_id) || t.workspace_id} / ${name}`;
    return `${shown}\ttab:${t.tab_id}`;
  });
  return [`＋ new tab\t${NEW_TAB_TOKEN}`, `＋ new workspace\t${NEW_WS_TOKEN}`, ...rows];
}

// fzf ran with --expect=alt-d: enter keeps the default right split, alt-d
// confirms with a down split. Direction is irrelevant for the sentinels.
function parsePaneChoice(
  expectKey: string,
  line: string
): { direction: SplitDirection; dest: PaneDest } | null {
  const token = line.split("\t")[1];
  if (!token) return null;
  const direction: SplitDirection = expectKey === "alt-d" ? "down" : "right";
  if (token === NEW_TAB_TOKEN) return { direction, dest: { kind: "new-tab" } };
  if (token === NEW_WS_TOKEN) return { direction, dest: { kind: "new-workspace" } };
  if (token.startsWith("tab:")) return { direction, dest: { kind: "tab", tabId: token.slice(4) } };
  return null;
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

function focusDestination(pane: MovedPane): void {
  herdrJSON(["workspace", "focus", pane.workspace_id]);
  herdrJSON(["tab", "focus", pane.tab_id]);
}

function executeTabMovePlan(plan: MovePlan & { mode: "tab" }): void {
  const { root, tabLabel } = plan;

  const rootAnchor = anchorOf(root);
  const createDestinationTabArgs = plan.toNewWorkspace
    ? ["pane", "move", rootAnchor, "--new-workspace", "--label", tabLabel, "--tab-label", tabLabel, "--no-focus"]
    : ["pane", "move", rootAnchor, "--new-tab", "--workspace", plan.destWs, "--label", tabLabel, "--no-focus"];
  const first = moveUntilChanged(createDestinationTabArgs);
  const newTab = first.pane.tab_id;
  const idMap: Record<string, string> = { [rootAnchor]: first.pane.pane_id };

  // Focus the destination now: the user watches it assemble while the source
  // dismantles off-screen. Pane moves stay --no-focus so focus jumps exactly once.
  focusDestination(first.pane);

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

// Omitting --target-pane splits the destination tab's focused pane, which is
// the intuitive landing spot.
function executePaneMovePlan(plan: MovePlan & { mode: "pane" }): void {
  const args =
    plan.dest.kind === "tab"
      ? ["pane", "move", plan.paneId, "--tab", plan.dest.tabId, "--split", plan.direction, "--no-focus"]
      : plan.dest.kind === "new-tab"
        ? ["pane", "move", plan.paneId, "--new-tab", "--workspace", plan.srcWs, "--no-focus"]
        : ["pane", "move", plan.paneId, "--new-workspace", "--no-focus"];
  const moved = moveUntilChanged(args);
  focusDestination(moved.pane);
}

function executeMovePlan(planPath: string): void {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as MovePlan;
  fs.unlinkSync(planPath);
  if (plan.mode === "pane") executePaneMovePlan(plan);
  else executeTabMovePlan(plan);
}

// A failed label lookup falls back silently: the move matters more than the name.
function sourceTabLabel(srcTab: string): string {
  try {
    const tab = herdrJSON<TabListResult>(["tab", "list"]).result.tabs.find((t) => t.tab_id === srcTab);
    if (tab && tab.label) return tab.label;
  } catch {}
  return "moved";
}

function livePaneTabs(): Map<string, string> {
  return new Map(herdrJSON<PaneListResult>(["pane", "list"]).result.panes.map((p) => [p.pane_id, p.tab_id]));
}

function sourceTabStillIntact(root: LayoutNode, srcTab: string): boolean {
  const live = livePaneTabs();
  return leavesOf(root).every((id) => live.get(id) === srcTab);
}

const FZF_NO_MATCH = 1;
const FZF_CANCELLED = 130;

interface FzfPick {
  outcome: "picked" | "cancelled" | "failed";
  stdout: string;
}

function runFzf(args: string[], input: string): FzfPick {
  const fzf = spawnSync("fzf", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  if (fzf.error) {
    keepPickerOpenUntilEnter("drovr: fzf not found on PATH.");
    return { outcome: "failed", stdout: "" };
  }
  if (fzf.status === FZF_NO_MATCH || fzf.status === FZF_CANCELLED) return { outcome: "cancelled", stdout: "" };
  if (fzf.status !== 0) {
    keepPickerOpenUntilEnter(`drovr: fzf exited with status ${fzf.status}.`);
    return { outcome: "failed", stdout: "" };
  }
  return { outcome: "picked", stdout: fzf.stdout || "" };
}

function writePlanAndDetach(plan: MovePlan, jobPath: string): void {
  const planPath = jobPath.replace("job-", "plan-");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  spawn(process.execPath, [import.meta.filename], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DROVR_PLAN: planPath },
  }).unref();
}

function pickTabMove(job: Job & { mode: "tab" }, jobPath: string): number {
  let root: LayoutNode;
  try {
    root = rootFromFlatSnapshot(job);
  } catch (err) {
    keepPickerOpenUntilEnter(`drovr: could not reconstruct source layout: ${errorMessage(err)}`);
    return 1;
  }
  const srcTab = job.tab_id;
  const srcWs = job.workspace_id;
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
  const fzf = runFzf(
    [
      "--prompt", "move tab to › ",
      "--header", "type to filter · enter moves · esc cancels",
      "--delimiter", "\t",
      "--with-nth", "1",
      "--height", "100%",
    ],
    lines
  );
  if (fzf.outcome === "cancelled") return 0;
  if (fzf.outcome === "failed") return 1;
  const choice = fzf.stdout.trim();
  if (!choice) return 0;

  if (!sourceTabStillIntact(root, srcTab)) {
    keepPickerOpenUntilEnter("drovr: the source tab changed while the picker was open; nothing was moved.");
    return 1;
  }

  let plan: MovePlan;
  if (choice === NEW_LABEL) {
    plan = { mode: "tab", root, tabLabel, toNewWorkspace: true };
  } else {
    const destWs = choice.split("\t")[1];
    if (!destWs) {
      keepPickerOpenUntilEnter(`drovr: could not parse the picked workspace: ${JSON.stringify(choice)}`);
      return 1;
    }
    plan = { mode: "tab", root, tabLabel, toNewWorkspace: false, destWs };
  }
  writePlanAndDetach(plan, jobPath);
  return 0;
}

function pickPaneMove(job: Job & { mode: "pane" }, jobPath: string): number {
  const tabs = herdrJSON<TabListResult>(["tab", "list"]).result.tabs;
  const workspaces = herdrJSON<WorkspaceListResult>(["workspace", "list"]).result.workspaces;

  const currentLines = paneDestLines(tabs, workspaces, job.tab_id, job.workspace_id, false);
  const allLines = paneDestLines(tabs, workspaces, job.tab_id, job.workspace_id, true);

  // ctrl-t reloads the full cross-workspace list from a pre-written file
  // (fzf's reload runs a command, so piped stdin alone can't feed it).
  const allPath = jobPath.replace("job-", "tabs-");
  fs.writeFileSync(allPath, allLines.join("\n"));
  try {
    const fzf = runFzf(
      [
        "--prompt", "move pane to › ",
        "--header", "enter splits right · alt-d splits down · ctrl-t all workspaces · esc cancels",
        "--delimiter", "\t",
        "--with-nth", "1",
        "--height", "100%",
        "--expect", "alt-d",
        "--bind", `ctrl-t:reload(cat '${allPath}')+change-prompt(move pane anywhere › )`,
      ],
      currentLines.join("\n")
    );
    if (fzf.outcome === "cancelled") return 0;
    if (fzf.outcome === "failed") return 1;

    // With --expect, line 1 is the confirming key ("" for enter), line 2 the pick.
    const [expectKey = "", picked = ""] = fzf.stdout.split("\n");
    if (!picked.trim()) return 0;
    const choice = parsePaneChoice(expectKey.trim(), picked);
    if (!choice) {
      keepPickerOpenUntilEnter(`drovr: could not parse the picked destination: ${JSON.stringify(picked)}`);
      return 1;
    }

    if (livePaneTabs().get(job.pane_id) !== job.tab_id) {
      keepPickerOpenUntilEnter("drovr: the source pane changed while the picker was open; nothing was moved.");
      return 1;
    }

    writePlanAndDetach(
      { mode: "pane", paneId: job.pane_id, srcWs: job.workspace_id, direction: choice.direction, dest: choice.dest },
      jobPath
    );
    return 0;
  } finally {
    try {
      fs.unlinkSync(allPath);
    } catch {}
  }
}

function main(): number {
  const jobPath = process.env.DROVR_JOB;
  let job: Job;
  try {
    if (!jobPath) throw new Error("DROVR_JOB is not set");
    job = JSON.parse(fs.readFileSync(jobPath, "utf8")) as Job;
    fs.unlinkSync(jobPath);
  } catch {
    keepPickerOpenUntilEnter("drovr: no pending job (run a drovr action, not this pane directly).");
    return 1;
  }
  return job.mode === "pane" ? pickPaneMove(job, jobPath) : pickTabMove(job, jobPath);
}

export { rootFromFlatSnapshot, secondChildRect, anchorOf, leavesOf, paneDestLines, parsePaneChoice };

if (process.argv[1] === import.meta.filename) {
  if (process.env.DROVR_PLAN) {
    try {
      executeMovePlan(process.env.DROVR_PLAN);
    } catch (err) {
      spawnSync(HB, ["notification", "show", "drovr: move failed", "--body", errorMessage(err)]);
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    process.exit(main());
  } catch (err) {
    keepPickerOpenUntilEnter(`drovr: ${errorMessage(err)}`);
    process.exit(1);
  }
}
