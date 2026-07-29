#!/usr/bin/env node
// Floating popup picker (herdr >= 0.7.4). A popup is a session resource, not
// a pane in the source tab, so nothing pins the source layout: fzf gets the
// popup's real TTY, and the moves run inline right after the pick.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

interface PaneLayoutResult {
  layout: LayoutSnapshot & { tab_id: string; workspace_id: string };
}

interface PaneGetResult {
  pane: { pane_id: string; tab_id: string; workspace_id: string };
}

interface MovedPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}

interface PaneMoveResult {
  move_result: { changed: boolean; pane: MovedPane };
}

export type PaneDest =
  | { kind: "tab"; tabId: string }
  | { kind: "new-tab" }
  | { kind: "new-workspace" };

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

// Candidate lines for the pane picker: destination tabs only (source tab
// excluded, source-workspace tabs first); the ＋ sentinels are appended by
// the callers. Column 2 carries the machine token; fzf hides it via
// --with-nth=1.
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
  return ordered.map((t) => {
    const name = t.label || t.tab_id;
    const shown = t.workspace_id === srcWsId ? name : `${wsLabel.get(t.workspace_id) || t.workspace_id} / ${name}`;
    return `${shown}\ttab:${t.tab_id}`;
  });
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

function move(args: string[]): MovedPane {
  const r = herdrJSON<PaneMoveResult>(args).result.move_result;
  if (!r.changed) {
    throw new Error(`herdr refused the move: herdr ${args.join(" ")}`);
  }
  return r.pane;
}

// Focus is a nicety on top of an already-completed move; if the server
// declines while the popup is up, the move still stands, so don't fail.
function focusDestination(pane: MovedPane): void {
  try {
    herdrJSON(["workspace", "focus", pane.workspace_id]);
    herdrJSON(["tab", "focus", pane.tab_id]);
  } catch {}
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

const FZF_NO_MATCH = 1;
const FZF_CANCELLED = 130;

// Herdr themes the popup's ANSI palette, so styling with palette names (never
// hex) makes the picker inherit whatever theme is active. Blue is herdr's
// accent; 8 is the muted "comment" tone its chrome uses for secondary text.
//
// Geometry (measured in a pty; every element must share one right boundary):
// fzf reserves the last content column on the input/info row, so the rule and
// count stop one column short of the content edge. --scrollbar reserves that
// same column in the list, pulling the highlight bar back to the rule's edge;
// it stays load-bearing even when nothing scrolls.
//
// The gaps must match in pixels, not cells, and vertical padding only comes in
// whole rows: 1 row of padding plus half the border row is ~1.5 cell heights,
// which is ~3.5 cell widths at typical font aspect. So each side carries 3
// blank columns to meet it: 3 of left padding; 1 of right padding plus the
// scrollbar slot plus the column herdr's popup insets on the right. gutter:8
// mutes the per-line ▌ bar; the pointer stays accent blue.
const FZF_STYLE = [
  "--layout", "reverse",
  "--info", "inline-right",
  "--scrollbar",
  "--pointer", "▌",
  "--highlight-line",
  "--ansi",
  "--padding", "1,1,1,3",
  "--footer-border", "none",
  "--color", "16,bg:-1,gutter:8,bg+:0,fg:7,fg+:15,hl:4,hl+:12,prompt:4,pointer:4,input-fg:15,info:8,footer:8,separator:8,spinner:8,scrollbar:8",
];

// Key hints, one per line, right-aligned to the same boundary as the rule and
// highlight bar: columns minus 7 (4 horizontal padding + 3 fzf reserves around
// footer lines; measured, stdout is the popup TTY).
function footer(lines: string[]): string {
  const w = (process.stdout.columns ?? 62) - 7;
  return lines.map((l) => l.padStart(w)).join("\n");
}

// The ＋ sentinel rows render in the muted tone (fzf runs with --ansi).
const MUTE = "\x1b[38;5;8m";
const UNMUTE = "\x1b[0m";
function mutedRow(label: string, token: string): string {
  return `${MUTE}${label}${UNMUTE}\t${token}`;
}

// fzf runs with --disabled and this script does the filtering, re-invoked per
// keystroke: the ＋ sentinel rows close the list under any query, echo the
// typed name so "＋ new tab “api”" reads as what enter will create, and enter
// always lands on the best real match. The reload re-runs node, not a shell
// script, so the picker needs nothing on PATH that the plugin doesn't already
// require — no sh, sleep, awk, or coreutils, which Windows has none of.
interface SearchSpec {
  candidates: string;
  sentinels: [string, string][];
  alt?: { candidates: string; marker: string; prompt: string; altPrompt: string };
}

// An extended-length prefix reaches argv when herdr resolves the plugin root
// through \\?\, and it does not survive a round trip back through a shell.
const SELF = import.meta.filename.replace(/^\\\\\?\\/, "");
// Re-invocations carry the bytecode cache too; without it each keystroke pays
// ~35ms to compile this file again.
const COMPILE_CACHE = pathToFileURL(path.join(import.meta.dirname, "compile-cache.js")).href;

function readSearchSpec(specPath: string): SearchSpec {
  return JSON.parse(fs.readFileSync(specPath, "utf8")) as SearchSpec;
}

function writeMatchingRows(specPath: string, query: string): void {
  const spec = readSearchSpec(specPath);
  const file = spec.alt && fs.existsSync(spec.alt.marker) ? spec.alt.candidates : spec.candidates;
  const candidates = fs.readFileSync(file, "utf8");
  const matched = query
    ? spawnSync("fzf", ["--filter", query], { input: candidates, encoding: "utf8" }).stdout || ""
    : candidates;
  const rows = matched.split("\n").filter((line) => line.length > 0);
  for (const [label, token] of spec.sentinels) {
    rows.push(mutedRow(query ? `${label} “${query}”` : label, token));
  }
  process.stdout.write(`${rows.join("\n")}\n`);
}

// Flips the marker the next reload reads, and hands fzf the matching prompt.
function writeScopeToggle(specPath: string): void {
  const alt = readSearchSpec(specPath).alt;
  if (!alt) return;
  if (fs.existsSync(alt.marker)) {
    fs.rmSync(alt.marker);
    process.stdout.write(`change-prompt(${alt.prompt})`);
  } else {
    fs.writeFileSync(alt.marker, "");
    process.stdout.write(`change-prompt(${alt.altPrompt})`);
  }
}

function nodeCommand(subcommand: string, specPath: string): string {
  return `node --import "${COMPILE_CACHE}" "${SELF}" ${subcommand} "${specPath}"`;
}

function searchCommand(specPath: string): string {
  return `${nodeCommand("--search", specPath)} {q}`;
}

// Reload on every keystroke: fzf kills the pending reload when the next change
// fires, and node's startup coalesces fast typing into one search.
function reloadOnChange(specPath: string): string[] {
  return ["--bind", `change:reload(${searchCommand(specPath)})`];
}

interface FzfPick {
  outcome: "picked" | "cancelled" | "failed";
  stdout: string;
}

// fzf draws straight on the terminal (/dev/tty, the console on Windows),
// leaving stdin/stdout free for candidates and the pick; --with-nth=1 hides
// the tab-delimited token column.
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

function moveTabFlow(srcPane: string): number {
  const snapshot = herdrJSON<PaneLayoutResult>(["pane", "layout", "--pane", srcPane]).result.layout;
  const root = rootFromFlatSnapshot(snapshot);
  const srcTab = snapshot.tab_id;
  const srcWs = snapshot.workspace_id;
  const tabLabel = sourceTabLabel(srcTab);

  const destinations = herdrJSON<WorkspaceListResult>(["workspace", "list"]).result.workspaces.filter(
    (w) => w.workspace_id !== srcWs
  );
  const wsRows = destinations.map((w) => `${w.label || w.workspace_id}\t${w.workspace_id}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drovr-"));
  const wsPath = path.join(dir, "workspaces.txt");
  const specPath = path.join(dir, "search.json");
  fs.writeFileSync(wsPath, wsRows.join("\n"));
  fs.writeFileSync(
    specPath,
    JSON.stringify({ candidates: wsPath, sentinels: [["＋ new workspace", NEW_WS_TOKEN]] })
  );

  let fzf: FzfPick;
  try {
    fzf = runFzf(
      [
        ...FZF_STYLE,
        "--prompt", "move tab to › ",
        "--footer", footer(["enter moves", "esc cancels"]),
        "--delimiter", "\t",
        "--with-nth", "1",
        "--print-query",
        "--disabled",
        ...reloadOnChange(specPath),
      ],
      [...wsRows, mutedRow("＋ new workspace", NEW_WS_TOKEN)].join("\n")
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (fzf.outcome === "cancelled") return 0;
  if (fzf.outcome === "failed") return 1;

  // With --print-query, line 1 is the typed query, line 2 the pick.
  const [queryRaw = "", picked = ""] = fzf.stdout.split("\n");
  if (!picked.trim()) return 0;
  const token = picked.split("\t")[1];
  if (!token) {
    keepPickerOpenUntilEnter(`drovr: could not parse the picked workspace: ${JSON.stringify(picked)}`);
    return 1;
  }

  // The popup is session-modal, so the user can't touch the layout while it
  // is open, but sibling agents driving the CLI still can; re-validate.
  const live = livePaneTabs();
  if (!leavesOf(root).every((id) => live.get(id) === srcTab)) {
    keepPickerOpenUntilEnter("drovr: the source tab changed while the picker was open; nothing was moved.");
    return 1;
  }

  const rootAnchor = anchorOf(root);
  // A typed query names the new workspace; the tab keeps its own label.
  const first = move(
    token === NEW_WS_TOKEN
      ? ["pane", "move", rootAnchor, "--new-workspace", "--label", queryRaw.trim() || tabLabel, "--tab-label", tabLabel, "--no-focus"]
      : ["pane", "move", rootAnchor, "--new-tab", "--workspace", token, "--label", tabLabel, "--no-focus"]
  );
  const newTab = first.tab_id;
  const idMap: Record<string, string> = { [rootAnchor]: first.pane_id };

  // Focus the destination now: it appears the instant the popup closes, and
  // pane moves stay --no-focus so focus jumps exactly once.
  focusDestination(first);

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
    const moved = move([
      "pane", "move", secondOld,
      "--tab", newTab,
      "--split", node.direction,
      "--target-pane", target,
      "--ratio", String(node.ratio),
      "--no-focus",
    ]);
    idMap[secondOld] = moved.pane_id;
    place(node.first);
    place(node.second);
  }
  place(root);
  return 0;
}

function movePaneFlow(srcPane: string): number {
  const src = herdrJSON<PaneGetResult>(["pane", "get", srcPane]).result.pane;
  const tabs = herdrJSON<TabListResult>(["tab", "list"]).result.tabs;
  const workspaces = herdrJSON<WorkspaceListResult>(["workspace", "list"]).result.workspaces;

  const currentLines = paneDestLines(tabs, workspaces, src.tab_id, src.workspace_id, false);
  const allLines = paneDestLines(tabs, workspaces, src.tab_id, src.workspace_id, true);

  // ctrl-t toggles between the scoped and cross-workspace lists: a marker
  // file carries the state, the search picks the file per reload. The
  // candidate files hold only real tabs; the search owns the sentinels.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drovr-"));
  const scopedPath = path.join(dir, "scoped.txt");
  const allPath = path.join(dir, "all.txt");
  const specPath = path.join(dir, "search.json");
  fs.writeFileSync(scopedPath, currentLines.join("\n"));
  fs.writeFileSync(allPath, allLines.join("\n"));
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      candidates: scopedPath,
      sentinels: [
        ["＋ new tab", NEW_TAB_TOKEN],
        ["＋ new workspace", NEW_WS_TOKEN],
      ],
      alt: {
        candidates: allPath,
        marker: path.join(dir, "all-on"),
        prompt: "move pane to › ",
        altPrompt: "move pane anywhere › ",
      },
    })
  );
  let fzf: FzfPick;
  try {
    fzf = runFzf(
      [
        ...FZF_STYLE,
        "--prompt", "move pane to › ",
        "--footer", footer(["enter splits right", "alt-d splits down", "ctrl-t all workspaces", "esc cancels"]),
        "--delimiter", "\t",
        "--with-nth", "1",
        "--print-query",
        "--disabled",
        "--expect", "alt-d",
        ...reloadOnChange(specPath),
        // transform[] (bracket delimiter: the body nests parens) flips the
        // marker and prompt; the chained reload re-filters the new scope.
        "--bind", `ctrl-t:transform[${nodeCommand("--toggle", specPath)}]+reload(${searchCommand(specPath)})`,
      ],
      [...currentLines, mutedRow("＋ new tab", NEW_TAB_TOKEN), mutedRow("＋ new workspace", NEW_WS_TOKEN)].join("\n")
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (fzf.outcome === "cancelled") return 0;
  if (fzf.outcome === "failed") return 1;

  // With --print-query and --expect: line 1 is the typed query, line 2 the
  // confirming key ("" for enter), line 3 the pick.
  const [queryRaw = "", expectKey = "", picked = ""] = fzf.stdout.split("\n");
  if (!picked.trim()) return 0;
  const choice = parsePaneChoice(expectKey.trim(), picked);
  if (!choice) {
    keepPickerOpenUntilEnter(`drovr: could not parse the picked destination: ${JSON.stringify(picked)}`);
    return 1;
  }

  if (livePaneTabs().get(src.pane_id) !== src.tab_id) {
    keepPickerOpenUntilEnter("drovr: the source pane changed while the picker was open; nothing was moved.");
    return 1;
  }

  // Omitting --target-pane splits the destination tab's focused pane, which
  // is the intuitive landing spot. A typed query names a new tab/workspace.
  const name = queryRaw.trim();
  const label = name ? ["--label", name] : [];
  const moved = move(
    choice.dest.kind === "tab"
      ? ["pane", "move", src.pane_id, "--tab", choice.dest.tabId, "--split", choice.direction, "--no-focus"]
      : choice.dest.kind === "new-tab"
        ? ["pane", "move", src.pane_id, "--new-tab", "--workspace", src.workspace_id, ...label, "--no-focus"]
        : ["pane", "move", src.pane_id, "--new-workspace", ...label, "--no-focus"]
  );
  focusDestination(moved);
  return 0;
}

function main(): number {
  const mode = process.env.DROVR_MODE;
  const pane = process.env.DROVR_PANE;
  if (!mode || !pane) {
    keepPickerOpenUntilEnter("drovr: no move context (run a drovr action, not this pane directly).");
    return 1;
  }
  return mode === "pane" ? movePaneFlow(pane) : moveTabFlow(pane);
}

export { rootFromFlatSnapshot, secondChildRect, anchorOf, leavesOf, paneDestLines, parsePaneChoice };

// --search / --toggle are fzf's reload and transform re-entering this file;
// they exit naturally so their stdout flushes before the process ends.
if (process.argv[1] === import.meta.filename) {
  const [, , subcommand, specPath = "", query = ""] = process.argv;
  try {
    if (subcommand === "--search") writeMatchingRows(specPath, query);
    else if (subcommand === "--toggle") writeScopeToggle(specPath);
    else process.exit(main());
  } catch (err) {
    if (!subcommand) keepPickerOpenUntilEnter(`drovr: ${errorMessage(err)}`);
    process.exit(1);
  }
}
