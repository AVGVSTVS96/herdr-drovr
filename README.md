# drovr

A [drover](https://en.wikipedia.org/wiki/Drover_(Australian)) moves herds between places. **drovr** does the same for your [herdr](https://herdr.dev) panes: move the focused **tab** to another workspace, or the focused **pane** into any tab, split layout **and** live agents included, picked with `fzf` in a floating panel.

Herdr has no built-in "move tab to workspace". Recreating a tab by reapplying its layout would respawn every pane, killing running Claude/Pi sessions and shells. drovr relocates the *live* panes instead (`herdr pane move`), so everything keeps running exactly where it left off.

<!-- TODO: record a short demo and drop it in ./assets/demo.gif
![demo](./assets/demo.gif)
-->

## Features

- 🚚 **Move tabs**: label, split layout, and every running pane relocate to another workspace
- 📦 **Move panes**: send the focused pane into any tab, split right or down, or into a fresh tab/workspace
- 🤖 Live agents survive every move: panes are relocated, never respawned
- 🎈 Floating `fzf` picker: type to filter, `enter` to move, `esc` to cancel; the tiled layout never shifts
- 🌐 `ctrl-t` in the pane picker reveals every workspace's tabs as destinations
- 🎯 Focus follows the move: you land where your pane or tab just arrived
- ✅ Every move is verified against the server; failures surface right in the picker

## Requirements

- Herdr `>= 0.7.4` (the picker is a floating popup panel, introduced in 0.7.4)
- `node >= 23` on `PATH` (the plugin is written in TypeScript and relies on Node's native type stripping to run the `.ts` files directly; there is no build step)
- `fzf` on `PATH` (`brew install fzf` on macOS)

## Installation

```bash
herdr plugin install AVGVSTVS96/herdr-drovr
```

Plugin manifests can't declare keybindings, so add these to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+M"
type = "plugin_action"
command = "drovr.move-tab"
description = "move tab to workspace"

[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "drovr.move-pane"
description = "move pane to tab"
```

Then reload Herdr config:

```bash
herdr server reload-config
```

That's it.

## Usage

### Move a tab

1. Focus the tab you want to move
2. Press `prefix+M`
3. Pick a destination workspace, or choose `＋ new workspace`

### Move a pane

1. Focus the pane you want to move
2. Press `prefix+m`
3. Pick a destination tab, `＋ new tab`, or `＋ new workspace`

Pane picker keys:

- `type` - filter destinations
- `enter` - move, splitting the destination's focused pane **right**
- `alt-d` - move, splitting **down** instead
- `ctrl-t` - show every workspace's tabs, not just the current workspace's
- `esc` - cancel

The picker is keyboard-driven (fzf semantics): a single mouse click only highlights a row. If the source tab or workspace becomes empty after a move, Herdr closes it.

## How it works

- `open-picker.ts` runs as the headless plugin action: it resolves the focused pane and opens the picker popup with the move context (`DROVR_MODE`, `DROVR_PANE`) in its environment.
- `pick-and-move.ts` runs inside the popup, so `fzf` has a real TTY. A popup is a session resource, not a pane in the source tab, so nothing pins the source layout and the moves run **inline right after the pick**, no second process, no retries.
- Tab moves reconstruct the layout tree from the rects Herdr actually reported (no ratio arithmetic), re-validate that every source pane still exists after the pick, then replay the tree in the destination: one `pane move --new-tab`/`--new-workspace` for the anchor, then one `pane move --split` per split node with the exact direction and ratio.
- Pane moves are a single `pane move --tab <id> --split right|down`. `--target-pane` is omitted, which splits the destination tab's focused pane, the intuitive landing spot.
- The destination is focused as soon as it exists, so it is front and center the instant the popup closes.

## Limitations

- The picker is a floating terminal popup, not a native menu; Herdr plugin v1 has no native UI or menu injection.
- There is no atomic `tab move` API, so a tab move is multiple `pane move` calls. Source panes are re-validated right before moving, but if a move still fails partway the plugin reports the failing command and does not roll back.
- The tab picker excludes the source workspace; the pane picker excludes the source tab.
- `ctrl-t` in the pane picker is one-way; press `esc` and reopen to go back to the current workspace's tabs.

## Development

```bash
git clone https://github.com/AVGVSTVS96/herdr-drovr
herdr plugin link ./herdr-drovr
herdr plugin action list --plugin drovr
npm install   # dev-only: typescript for typechecking (the plugin itself has zero dependencies)
npm test      # runs tsc --noEmit, then the layout-tree and picker-parsing tests
```

## License

[MIT](LICENSE)
