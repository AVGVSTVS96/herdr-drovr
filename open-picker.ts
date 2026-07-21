#!/usr/bin/env node
// Headless action behind the keybindings: resolves the focused pane and
// opens the floating picker, sized to its content, with the move context
// in its environment.
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

// Popup outer size: command-palette width, height fitted to the largest list
// this run can show (ctrl-t widens the pane list, and popups don't resize
// once open). Any listing failure falls back to the manifest defaults.
const WIDTH = 64;
// Popup border + fzf padding + prompt + separator, plus the footer hints
// (4 lines in pane mode, 2 in tab mode).
function chrome(mode: string): number {
  return 6 + (mode === "pane" ? 4 : 2);
}

function listRows(mode: string): number {
  if (mode === "pane") {
    // All tabs minus the source, plus the two sentinel rows.
    return herdrJSON<{ tabs: unknown[] }>(["tab", "list"]).result.tabs.length + 1;
  }
  // Workspaces minus the source, plus the new-workspace sentinel.
  return herdrJSON<{ workspaces: unknown[] }>(["workspace", "list"]).result.workspaces.length;
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

  const sizeArgs: string[] = [];
  try {
    const height = Math.min(Math.max(listRows(mode) + chrome(mode), 13), 28);
    sizeArgs.push("--width", String(WIDTH), "--height", String(height));
  } catch {}

  const open = spawnSync(
    HB,
    [
      "plugin", "pane", "open",
      "--plugin", pluginId,
      "--entrypoint", "picker",
      ...sizeArgs,
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
