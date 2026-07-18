#!/usr/bin/env node
// Headless action behind the keybindings. Captures what is being moved
// BEFORE the picker exists (so the picker can't pollute the capture), then
// opens the picker with the job file's path in DROVR_JOB.
//
// Modes (argv[2]): "tab" snapshots the focused tab's layout; "pane" records
// just the focused pane's identity.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Job, JobSnapshot } from "./pick-and-move.ts";

const HB = process.env.HERDR_BIN_PATH || "herdr";

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const pluginId = process.env.HERDR_PLUGIN_ID || "drovr";

interface PaneListResult {
  panes: { pane_id: string; focused: boolean }[];
}

interface PaneLayoutResult {
  layout: JobSnapshot;
}

interface PaneGetResult {
  pane: { pane_id: string; tab_id: string; workspace_id: string };
}

function herdrJSON<T>(args: string[]): { result: T } {
  const r = spawnSync(HB, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return JSON.parse(r.stdout) as { result: T };
}

// herdr >= 0.7.4 supports floating popup pickers; older servers reject the
// placement override, so fall back to the manifest's zoomed overlay.
function openPicker(jobPath: string): void {
  const base = [
    "plugin", "pane", "open",
    "--plugin", pluginId,
    "--entrypoint", "picker",
    "--env", `DROVR_JOB=${jobPath}`,
  ];
  let open = spawnSync(HB, [...base, "--placement", "popup"], { encoding: "utf8" });
  if (open.status !== 0 && /invalid pane placement/i.test(`${open.stderr || ""}${open.stdout || ""}`)) {
    open = spawnSync(HB, base, { encoding: "utf8" });
  }
  if (open.status !== 0) {
    throw new Error(`could not open picker: ${(open.stderr || open.stdout || "").trim()}`);
  }
}

try {
  const mode = process.argv[2] === "pane" ? "pane" : "tab";

  let pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    const focused = herdrJSON<PaneListResult>(["pane", "list"]).result.panes.find((p) => p.focused);
    if (!focused) {
      console.error("drovr: no focused pane to act on");
      process.exit(1);
    }
    pane = focused.pane_id;
  }

  let job: Job;
  if (mode === "pane") {
    const p = herdrJSON<PaneGetResult>(["pane", "get", pane]).result.pane;
    job = { mode, pane_id: p.pane_id, tab_id: p.tab_id, workspace_id: p.workspace_id };
  } else {
    job = { mode, ...herdrJSON<PaneLayoutResult>(["pane", "layout", "--pane", pane]).result.layout };
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const jobPath = path.join(stateDir, `job-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(job));
  openPicker(jobPath);
} catch (err) {
  console.error("drovr (capture):", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
