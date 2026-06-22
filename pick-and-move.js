#!/usr/bin/env node
// Picker pane command. Runs inside a real Herdr overlay pane (it has a TTY),
// so fzf works here. Reads the job file the action wrote, asks the user which
// workspace to move the tab to, then relocates the tab's live panes —
// preserving the exact split layout — using `herdr pane move`.

"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HB = process.env.HERDR_BIN_PATH || "herdr";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const jobPath = path.join(stateDir, "job.json");

function herdr(args) {
  const r = spawnSync(HB, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout;
}
const herdrJSON = (args) => JSON.parse(herdr(args));

// Show a message on the pane's TTY and wait for Enter, so errors/confirmation
// are visible before the overlay closes.
function pause(msg) {
  process.stderr.write(`\n${msg}\n[enter] `);
  spawnSync("bash", ["-c", "read -r _ </dev/tty"], { stdio: "inherit" });
}

// leftmost / topmost leaf of a layout subtree
function anchorOf(node) {
  return node.type === "pane" ? node.pane_id : anchorOf(node.first);
}

function rectEq(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function splitRect(area, direction, ratio) {
  if (direction === "right") {
    const firstW = Math.round(area.width * ratio);
    return [
      { x: area.x, y: area.y, width: firstW, height: area.height },
      { x: area.x + firstW, y: area.y, width: Math.max(0, area.width - firstW), height: area.height },
    ];
  }
  if (direction === "down") {
    const firstH = Math.round(area.height * ratio);
    return [
      { x: area.x, y: area.y, width: area.width, height: firstH },
      { x: area.x, y: area.y + firstH, width: area.width, height: Math.max(0, area.height - firstH) },
    ];
  }
  throw new Error(`unknown split direction: ${direction}`);
}

function rootFromFlatSnapshot(snapshot) {
  if (!snapshot || !snapshot.area || !Array.isArray(snapshot.panes) || !Array.isArray(snapshot.splits)) {
    throw new Error("layout snapshot is missing area/panes/splits");
  }

  const panes = snapshot.panes;
  const splits = snapshot.splits;

  function build(area) {
    const split = splits.find((s) => rectEq(s.rect, area));
    if (split) {
      const [firstArea, secondArea] = splitRect(area, split.direction, split.ratio);
      return {
        type: "split",
        direction: split.direction,
        ratio: split.ratio,
        first: build(firstArea),
        second: build(secondArea),
      };
    }

    const pane = panes.find((p) => rectEq(p.rect, area));
    if (!pane) {
      throw new Error(`could not map layout area to pane/split: ${JSON.stringify(area)}`);
    }
    return { type: "pane", pane_id: pane.pane_id };
  }

  return build(snapshot.area);
}

function rootFromLayoutResponse(layoutResponse) {
  const layout = layoutResponse && layoutResponse.result && layoutResponse.result.layout;
  if (!layout) return null;
  // Older notes expected a nested root; current v0.7 pane.layout returns a flat snapshot.
  if (layout.root) return layout.root;
  return rootFromFlatSnapshot(layout);
}

function main() {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  } catch {
    pause("tab-mover: no pending job (run the action again).");
    return 1;
  }

  let root = null;
  try {
    root = rootFromLayoutResponse(job.layout);
  } catch (err) {
    pause(`tab-mover: could not reconstruct source layout: ${err.message}`);
    return 1;
  }
  const srcTab = job.src_tab;
  const srcWs = job.src_ws;
  if (!root) {
    pause("tab-mover: could not read source layout.");
    return 1;
  }

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
  const choice = (fzf.stdout || "").trim();
  if (fzf.status !== 0 || !choice) return 0; // cancelled — leave everything as-is

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

  try { fs.unlinkSync(jobPath); } catch { /* ignore */ }
  // Do not force focus. Moving the active tab may still cause Herdr to choose
  // a fallback focus when the source tab empties, but the plugin should not add
  // an extra jump after a successful move.
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  pause(`tab-mover: ${err.message}`);
  process.exit(1);
}
