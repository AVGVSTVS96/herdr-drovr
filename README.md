# herdr-tab-mover

A Herdr plugin for moving the focused tab — its split layout *and* live panes/agents — to another workspace with an `fzf` picker.

It uses `herdr pane move`, not `layout apply`, so Claude/Pi/shell panes are relocated instead of respawned.

## requirements

- Herdr `>= 0.7.0`
- `node` on `PATH`
- `fzf` on `PATH`

macOS:

```bash
brew install fzf
```

## install

### from github, after publishing

```bash
herdr plugin install AVGVSTVS96/herdr-tab-mover
```

### local development

```bash
herdr plugin link /Users/bassimshahidy/Documents/GitHub/side-projects/herdr-tab-mover
herdr plugin list
herdr plugin action list --plugin tab-mover
```

## keybinding

Plugin manifests cannot declare keys, so add this to `~/.config/herdr/config.toml`:

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

## usage

1. focus the tab you want to move
2. press `prefix+M`
3. pick a destination workspace in the overlay `fzf` picker, or choose `＋ new workspace`
4. press enter to move, or escape to cancel

The picker is keyboard-driven: type to filter, `enter` to move, `esc` to cancel. Single mouse clicks only highlight a row (fzf semantics), and clicking outside the overlay dismisses it without moving anything.

The destination gets a new tab with the same label and split layout. If the source tab/workspace becomes empty, Herdr closes it.

## how it works

- `capture-and-open.js` runs as the headless plugin action. It takes an exact `pane layout` snapshot of the focused tab before the picker exists (the snapshot carries the tab and workspace ids), writes it to a per-invocation job file, and opens the picker pane with the job path in `TAB_MOVER_JOB`.
- `pick-and-move.js` runs inside an overlay pane, so `fzf` has a real TTY. It reconstructs the layout tree by matching the rects Herdr actually reported (no ratio arithmetic) and re-checks that every source pane still exists after the pick.
- The moves happen in a **detached second pass** (`TAB_MOVER_PLAN` mode of the same script). The overlay is attached to the very tab being moved, and Herdr silently no-ops (`changed: false`) any `pane move` out of a tab that still hosts the overlay — so the picker writes a plan, spawns itself detached, and exits to close the overlay, while the mover retries each move until the server actually performs it. Mover failures surface via `herdr notification show`.
- Focus follows the move: after the last pane lands, the mover focuses the destination workspace and tab, so you stay in the tab you just moved.

## limitations

- This is an overlay terminal picker, not a native right-click menu. Herdr plugin v1 does not support native menu injection or non-terminal UI.
- There is no atomic `tab move` API, so this is implemented as multiple `pane move` calls. The plugin re-validates all source panes right before moving, but if a move still fails partway it reports the failing command and does not roll back.
- Destination choices exclude the source workspace.

## development

```bash
npm test
```

That syntax-checks the JavaScript entrypoints and runs unit tests for the layout-tree reconstruction.

## publishing

1. create a GitHub repo, e.g. `AVGVSTVS96/herdr-tab-mover`
2. push this repo
3. add the GitHub topic `herdr-plugin`
4. users install with:

```bash
herdr plugin install AVGVSTVS96/herdr-tab-mover
```
