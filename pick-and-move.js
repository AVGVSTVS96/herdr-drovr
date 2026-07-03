#!/usr/bin/env node
// Picker pane command. Runs inside a real Herdr overlay pane (it has a TTY),
// so fzf works here. Reads the layout snapshot the action wrote (path passed
// via TAB_MOVER_JOB), asks the user which workspace to move the tab to, then
// relocates the tab's live panes — preserving the exact split layout — using
// `herdr pane move`.

"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const HB = process.env.HERDR_BIN_PATH || "herdr";

function herdrJSON(args) {
  const r = spawnSync(HB, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return JSON.parse(r.stdout);
}

// Show a message on the pane's TTY and wait for Enter, so errors/confirmation
// are visible before the overlay closes.
function pause(msg) {
  process.stderr.write(`\n${msg}\n[enter] `);
  try {
    fs.readSync(0, Buffer.alloc(64), 0, 64);
  } catch {
    /* stdin closed — nothing to wait for */
  }
}

function rectEq(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// The rect flush against `area`'s far edge, spanning the full cross dimension.
// Nested descendants on that side match the same edges but are strictly
// smaller, so the largest match is the split's second child.
function secondChildRect(rects, area, direction) {
  const fits =
    direction === "right"
      ? (r) => r.y === area.y && r.height === area.height && r.x > area.x && r.x + r.width === area.x + area.width
      : (r) => r.x === area.x && r.width === area.width && r.y > area.y && r.y + r.height === area.y + area.height;
  let best = null;
  for (const r of rects) {
    if (fits(r) && (!best || r.width * r.height > best.width * best.height)) best = r;
  }
  if (!best) {
    throw new Error(`could not find the second child of the ${direction} split at ${JSON.stringify(area)}`);
  }
  return best;
}

// Rebuild the split tree from Herdr's flat panes/splits snapshot. Every child
// rect is looked up among the rects Herdr actually reported — never re-derived
// from ratio arithmetic — so rounding can't desynchronize us from the server.
function rootFromFlatSnapshot(snapshot) {
  if (!snapshot || !snapshot.area || !Array.isArray(snapshot.panes) || !Array.isArray(snapshot.splits)) {
    throw new Error("layout snapshot is missing area/panes/splits");
  }
  const rects = [...snapshot.panes, ...snapshot.splits].map((e) => e.rect);

  function build(area) {
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

// leftmost / topmost leaf of a layout subtree
function anchorOf(node) {
  return node.type === "pane" ? node.pane_id : anchorOf(node.first);
}

function leavesOf(node, out = []) {
  if (node.type === "pane") out.push(node.pane_id);
  else {
    leavesOf(node.first, out);
    leavesOf(node.second, out);
  }
  return out;
}

function main() {
  const jobPath = process.env.TAB_MOVER_JOB;
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    fs.unlinkSync(jobPath);
  } catch {
    pause("tab-mover: no pending job (run the move-tab action, not this pane directly).");
    return 1;
  }

  let root;
  try {
    root = rootFromFlatSnapshot(snapshot);
  } catch (err) {
    pause(`tab-mover: could not reconstruct source layout: ${err.message}`);
    return 1;
  }
  const srcTab = snapshot.tab_id;
  const srcWs = snapshot.workspace_id;

  // Source tab label -> name the new tab the same.
  let tabLabel = "moved";
  try {
    const t = herdrJSON(["tab", "list"]).result.tabs.find((x) => x.tab_id === srcTab);
    if (t && t.label) tabLabel = t.label;
  } catch {
    /* keep default */
  }

  // Candidate destinations: every workspace except the source. Plus "new".
  const workspaces = herdrJSON(["workspace", "list"]).result.workspaces.filter(
    (w) => w.workspace_id !== srcWs
  );
  const NEW_LABEL = "＋ new workspace";
  const lines = [
    NEW_LABEL,
    ...workspaces.map((w) => `${w.label || w.workspace_id}\t${w.workspace_id}`),
  ].join("\n");

  // fzf draws its UI on /dev/tty; we feed candidates on stdin, read the pick
  // from stdout. --with-nth=1 hides the tab-delimited workspace id column.
  const fzf = spawnSync(
    "fzf",
    ["--prompt", "move tab to › ", "--delimiter", "\t", "--with-nth", "1", "--height", "100%"],
    { input: lines, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }
  );
  if (fzf.error) {
    pause("tab-mover: fzf not found on PATH.");
    return 1;
  }
  if (fzf.status === 1 || fzf.status === 130) return 0; // no match / cancelled
  if (fzf.status !== 0) {
    pause(`tab-mover: fzf exited with status ${fzf.status}.`);
    return 1;
  }
  const choice = (fzf.stdout || "").trim();
  if (!choice) return 0;

  // The snapshot was taken at keypress; panes may have closed or moved while
  // the picker was open. Refuse rather than start a move we can't finish.
  const live = new Map(herdrJSON(["pane", "list"]).result.panes.map((p) => [p.pane_id, p.tab_id]));
  if (leavesOf(root).some((id) => live.get(id) !== srcTab)) {
    pause("tab-mover: the source tab changed while the picker was open; nothing was moved.");
    return 1;
  }

  const toNewWorkspace = choice === NEW_LABEL;
  const destWs = toNewWorkspace ? null : choice.split("\t")[1];

  // 1) Move the root anchor to create the destination tab.
  const rootAnchor = anchorOf(root);
  const firstArgs = toNewWorkspace
    ? ["pane", "move", rootAnchor, "--new-workspace", "--label", tabLabel, "--tab-label", tabLabel, "--no-focus"]
    : ["pane", "move", rootAnchor, "--new-tab", "--workspace", destWs, "--label", tabLabel, "--no-focus"];
  const first = herdrJSON(firstArgs).result.move_result;
  const newTab = first.pane.tab_id;
  const idMap = { [rootAnchor]: first.pane.pane_id };

  // 2) Walk the tree. For each split, carve the SECOND region out of the pane
  //    currently filling the node's region (the anchor of FIRST), then recurse.
  //    Herdr's --ratio is the fraction retained by the target (first) pane,
  //    which is exactly LayoutNode.ratio. Directions ("right"/"down") map 1:1.
  function place(node) {
    if (node.type === "pane") return;
    const hostOld = anchorOf(node);
    const secondOld = anchorOf(node.second);
    const hostNew = idMap[hostOld];
    const resp = herdrJSON([
      "pane", "move", secondOld,
      "--tab", newTab,
      "--split", node.direction,
      "--target-pane", hostNew,
      "--ratio", String(node.ratio),
      "--no-focus",
    ]).result.move_result;
    idMap[secondOld] = resp.pane.pane_id;
    place(node.first);
    place(node.second);
  }
  place(root);

  // Do not force focus. Moving the active tab may still cause Herdr to choose
  // a fallback focus when the source tab empties, but the plugin should not add
  // an extra jump after a successful move.
  return 0;
}

module.exports = { rootFromFlatSnapshot, secondChildRect, anchorOf, leavesOf };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    pause(`tab-mover: ${err.message}`);
    process.exit(1);
  }
}
