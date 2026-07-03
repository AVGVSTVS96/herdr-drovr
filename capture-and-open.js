#!/usr/bin/env node
// Action command (headless). Triggered by the keybinding.
//
// Captures the focused tab's exact layout snapshot BEFORE the picker pane is
// created — so the picker can't contaminate the layout we reconstruct — then
// writes a job file and opens the fzf picker pane, passing the job path to it
// via TAB_MOVER_JOB. The snapshot itself carries tab_id/workspace_id, so it is
// the single source of truth for what gets moved.
//
// All Herdr calls go through HERDR_BIN_PATH so this stays portable.

"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HB = process.env.HERDR_BIN_PATH || "herdr";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const pluginId = process.env.HERDR_PLUGIN_ID || "tab-mover";

function herdrJSON(args) {
  const r = spawnSync(HB, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return JSON.parse(r.stdout);
}

try {
  // Prefer the invocation context; fall back to the focused pane if the
  // keybinding didn't populate HERDR_PANE_ID.
  let pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    const focused = herdrJSON(["pane", "list"]).result.panes.find((p) => p.focused);
    if (!focused) {
      console.error("tab-mover: no focused pane to act on");
      process.exit(1);
    }
    pane = focused.pane_id;
  }

  const snapshot = herdrJSON(["pane", "layout", "--pane", pane]).result.layout;

  fs.mkdirSync(stateDir, { recursive: true });
  const jobPath = path.join(stateDir, `job-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(snapshot));

  const open = spawnSync(
    HB,
    [
      "plugin", "pane", "open",
      "--plugin", pluginId,
      "--entrypoint", "picker",
      "--env", `TAB_MOVER_JOB=${jobPath}`,
    ],
    { encoding: "utf8" }
  );
  if (open.status !== 0) {
    throw new Error(`could not open picker: ${(open.stderr || open.stdout || "").trim()}`);
  }
} catch (err) {
  console.error("tab-mover (capture):", err.message);
  process.exit(1);
}
