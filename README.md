# herdr-tab-mover

Move the focused tab, split layout **and** live panes/agents included, to another workspace, picked with `fzf`.

Herdr has no built-in "move tab to workspace". Recreating the tab by reapplying its layout would respawn every pane, killing running Claude/Pi sessions and shells. This plugin relocates the *live* panes instead (`herdr pane move`), so everything keeps running exactly where it left off.

<!-- TODO: record a short demo and drop it in ./assets/demo.gif
![demo](./assets/demo.gif)
-->

## Features

- 🚚 Moves the whole tab: label, split layout, and every running pane
- 🤖 Live agents survive the move: panes are relocated, never respawned
- 🔍 Overlay `fzf` picker: type to filter, `enter` to move, `esc` to cancel
- ➕ Create a new workspace as the destination, right from the picker
- 🎯 Focus follows the move: you land in the tab you just moved
- ✅ Every move is verified against the server; failures surface as notifications

## Requirements

- Herdr `>= 0.7.0`
- `node >= 18` on `PATH`
- `fzf` on `PATH` (`brew install fzf` on macOS)

## Installation

```bash
herdr plugin install AVGVSTVS96/herdr-tab-mover
```

Plugin manifests can't declare keybindings, so add one to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+M"
type = "plugin_action"
command = "tab-mover.move-tab"
description = "move tab to workspace"
```

Then reload Herdr config:

```bash
herdr server reload-config
```

That's it.

## Usage

1. Focus the tab you want to move
2. Press `prefix+M`
3. Pick a destination workspace, or choose `＋ new workspace`

Picker keys:

- `type` - filter workspaces
- `enter` - move the tab
- `esc` - cancel

The picker is keyboard-driven (fzf semantics): a single mouse click only highlights a row, and clicking outside the overlay dismisses it without moving anything. The destination gets a new tab with the same label and split layout. If the source tab or workspace becomes empty, Herdr closes it.

## How it works

- `capture-and-open.js` runs as the headless plugin action. It takes an exact `pane layout` snapshot of the focused tab *before* the picker exists (so the picker pane can never pollute the capture), writes it to a per-invocation job file, and opens the picker pane with the job path in `TAB_MOVER_JOB`.
- `pick-and-move.js` runs inside an overlay pane, so `fzf` has a real TTY. It reconstructs the layout tree from the rects Herdr actually reported (no ratio arithmetic) and re-checks that every source pane still exists after the pick.
- The moves happen in a **detached second pass** (`TAB_MOVER_PLAN` mode of the same script). The overlay is attached to the very tab being moved, and Herdr silently no-ops (`changed: false`) any `pane move` out of a tab that still hosts the overlay, so the picker writes a plan, spawns itself detached, and exits to close the overlay, while the mover retries each move until the server actually performs it. Mover failures surface via `herdr notification show`.
- After the last pane lands, the mover focuses the destination workspace and tab.

## Limitations

- The picker is an overlay terminal, not a native menu; Herdr plugin v1 has no native UI or menu injection.
- There is no atomic `tab move` API, so the move is multiple `pane move` calls. Source panes are re-validated right before moving, but if a move still fails partway the plugin reports the failing command and does not roll back.
- The source workspace is excluded from the destination list.

## Development

```bash
git clone https://github.com/AVGVSTVS96/herdr-tab-mover
herdr plugin link ./herdr-tab-mover
herdr plugin action list --plugin tab-mover
npm test   # syntax-checks the entrypoints and unit-tests the layout-tree reconstruction
```

## License

[MIT](LICENSE)
