#!/usr/bin/env node
// Headless action behind the keybinding. Snapshots the focused tab's layout
// BEFORE the picker pane exists (so the picker can't pollute the capture),
// then opens the picker with the job file's path in TAB_MOVER_JOB.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { JobSnapshot } from "./pick-and-move.ts";

const HB = process.env.HERDR_BIN_PATH || "herdr";

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const pluginId = process.env.HERDR_PLUGIN_ID || "tab-mover";

interface PaneListResult {
  panes: { pane_id: string; focused: boolean }[];
}

interface PaneLayoutResult {
  layout: JobSnapshot;
}

function herdrJSON<T>(args: string[]): { result: T } {
  const r = spawnSync(HB, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return JSON.parse(r.stdout) as { result: T };
}

try {
  let pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    const focused = herdrJSON<PaneListResult>(["pane", "list"]).result.panes.find((p) => p.focused);
    if (!focused) {
      console.error("tab-mover: no focused pane to act on");
      process.exit(1);
    }
    pane = focused.pane_id;
  }

  const snapshot = herdrJSON<PaneLayoutResult>(["pane", "layout", "--pane", pane]).result.layout;

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
  console.error("tab-mover (capture):", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
