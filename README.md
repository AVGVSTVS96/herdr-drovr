# drovr

A [drover](https://en.wikipedia.org/wiki/Drover_(Australian)) moves herds between places. **drovr** does the same for your [herdr](https://herdr.dev) panes: move the focused **tab** to another workspace, or the focused **pane** into any tab, split layout **and** live agents included, picked with `fzf`.

Herdr has no built-in "move tab to workspace". Recreating a tab by reapplying its layout would respawn every pane, killing running Claude/Pi sessions and shells. drovr relocates the *live* panes instead (`herdr pane move`), so everything keeps running exactly where it left off.

<!-- TODO: record a short demo and drop it in ./assets/demo.gif
![demo](./assets/demo.gif)
-->

## Features

- 🚚 **Move tabs**: label, split layout, and every running pane relocate to another workspace
- 📦 **Move panes**: send the focused pane into any tab, split right or down, or into a fresh tab/workspace
- 🤖 Live agents survive every move: panes are relocated, never respawned
- 🔍 Overlay `fzf` picker: type to filter, `enter` to move, `esc` to cancel
- 🎈 Floating picker on herdr ≥ 0.7.4: opens as a popup panel; older versions automatically fall back to the zoomed overlay
- 🌐 `ctrl-t` in the pane picker reveals every workspace's tabs as destinations
- 🎯 Focus follows the move: you land where your pane or tab just arrived
- ✅ Every move is verified against the server; failures surface as notifications

## Requirements

- Herdr `>= 0.7.0` (`>= 0.7.4` for the floating picker)
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

The picker is keyboard-driven (fzf semantics): a single mouse click only highlights a row, and clicking outside dismisses it without moving anything. If the source tab or workspace becomes empty after a move, Herdr closes it.

## How it works

- `capture-and-open.ts` runs as the headless plugin action. It captures what is being moved *before* the picker exists (so the picker can never pollute the capture): an exact `pane layout` snapshot for tab moves, the pane's identity for pane moves. It writes a per-invocation job file and opens the picker with the job path in `DROVR_JOB`. The open request asks for a floating `popup` placement first; servers older than 0.7.4 reject that placement, and it falls back to the manifest's zoomed overlay.
- `pick-and-move.ts` runs inside the picker pane, so `fzf` has a real TTY. For tab moves it reconstructs the layout tree from the rects Herdr actually reported (no ratio arithmetic); for pane moves it lists destination tabs. Either way it re-checks that the source still exists after the pick.
- The moves happen in a **detached second pass** (`DROVR_PLAN` mode of the same script). Under the overlay fallback, the picker is attached to the very tab being moved out of, and Herdr silently no-ops (`changed: false`) any `pane move` out of a tab that still hosts the overlay; the picker therefore writes a plan, spawns itself detached, and exits to close the overlay, while the mover retries each move until the server actually performs it. Under the 0.7.4+ popup nothing is pinned and the retries simply succeed immediately, so one execution path serves both. Mover failures surface via `herdr notification show`.
- Pane moves into an existing tab use `pane move --tab <id> --split right|down` without `--target-pane`, which splits the destination tab's focused pane, the intuitive landing spot.
- For tab moves, as soon as the first move creates the destination tab, the mover focuses the destination workspace and tab; you watch the tab assemble there while the source dismantles off-screen.

## Limitations

- The picker is a terminal pane (floating popup on 0.7.4+, zoomed overlay before), not a native menu; Herdr plugin v1 has no native UI or menu injection.
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
