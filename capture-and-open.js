#!/usr/bin/env node
// Action command (headless). Triggered by the keybinding.
//
// Responsibilities:
//   1. Figure out the source tab (the focused tab when the key was pressed).
//   2. Capture that tab's EXACT layout snapshot now, before the picker pane is
//      created — so the picker can't contaminate the layout we reconstruct.
//   3. Persist a job file, then open the fzf picker pane.
//
// All Herdr calls go through HERDR_BIN_PATH so this stays portable.

"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HB = process.env.HERDR_BIN_PATH || "herdr";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const pluginId = process.env.HERDR_PLUGIN_ID || "avgvstvs96.tab-mover";

function herdrJSON(args) {
  const r = spawnSync(HB, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return JSON.parse(r.stdout);
}

try {
  // Prefer the invocation context; fall back to the focused pane if the
  // keybinding didn't populate HERDR_TAB_ID / HERDR_PANE_ID.
  let srcTab = process.env.HERDR_TAB_ID;
  let pane = process.env.HERDR_PANE_ID;
  if (!srcTab || !pane) {
    const panes = herdrJSON(["pane", "list"]).result.panes;
    const focused = panes.find((p) => p.focused) || panes[0];
    if (!focused) {
      console.error("tab-mover: no panes to act on");
      process.exit(1);
    }
    srcTab = srcTab || focused.tab_id;
    pane = pane || focused.pane_id;
  }

  const srcWs = srcTab.split(":")[0];
  const layout = herdrJSON(["pane", "layout", "--pane", pane]); // full PaneLayoutSnapshot response

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "job.json"),
    JSON.stringify({ src_tab: srcTab, src_ws: srcWs, layout })
  );

  // Fire-and-forget: the server owns the picker pane's lifetime, not us.
  spawnSync(HB, ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "picker"], {
    stdio: "ignore",
  });
} catch (err) {
  console.error("tab-mover (capture):", err.message);
  process.exit(1);
}
