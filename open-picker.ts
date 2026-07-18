#!/usr/bin/env node
// Headless action behind the keybindings: resolves the focused pane and
// opens the floating picker with the move context in its environment.
//
// Modes (argv[2]): "tab" moves the pane's whole tab; "pane" moves just the pane.

import { spawnSync } from "node:child_process";

const HB = process.env.HERDR_BIN_PATH || "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID || "drovr";

interface PaneListResult {
  panes: { pane_id: string; focused: boolean }[];
}

try {
  const mode = process.argv[2] === "pane" ? "pane" : "tab";

  let pane = process.env.HERDR_PANE_ID;
  if (!pane) {
    const list = spawnSync(HB, ["pane", "list"], { encoding: "utf8" });
    if (list.status !== 0) {
      throw new Error(`herdr pane list failed: ${(list.stderr || list.stdout || "").trim()}`);
    }
    const focused = (JSON.parse(list.stdout) as { result: PaneListResult }).result.panes.find((p) => p.focused);
    if (!focused) {
      console.error("drovr: no focused pane to act on");
      process.exit(1);
    }
    pane = focused.pane_id;
  }

  const open = spawnSync(
    HB,
    [
      "plugin", "pane", "open",
      "--plugin", pluginId,
      "--entrypoint", "picker",
      "--env", `DROVR_MODE=${mode}`,
      "--env", `DROVR_PANE=${pane}`,
    ],
    { encoding: "utf8" }
  );
  if (open.status !== 0) {
    throw new Error(`could not open picker: ${(open.stderr || open.stdout || "").trim()}`);
  }
} catch (err) {
  console.error("drovr (open):", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
