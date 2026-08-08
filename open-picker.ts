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

function herdrJSON<T>(args: string[]): { result: T } {
  const r = spawnSync(HB, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return JSON.parse(r.stdout) as { result: T };
}

// A stable command-palette size leaves breathing room for short lists; fzf
// scrolls longer lists within the same viewport.
const WIDTH = 64;
const HEIGHT = 28;

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

  const open = spawnSync(
    HB,
    [
      "plugin", "pane", "open",
      "--plugin", pluginId,
      "--entrypoint", "picker",
      "--width", String(WIDTH),
      "--height", String(HEIGHT),
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
