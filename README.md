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
herdr plugin action list --plugin avgvstvs96.tab-mover
```

## keybinding

Plugin manifests cannot declare keys, so add this to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+M"
type = "plugin_action"
command = "avgvstvs96.tab-mover.move-tab"
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

The destination gets a new tab with the same label and split layout. If the source tab/workspace becomes empty, Herdr closes it.

## how it works

- `capture-and-open.js` runs as the headless plugin action. It records the focused tab id and exact `pane layout` snapshot before the picker exists, then opens the picker pane.
- `pick-and-move.js` runs inside an overlay pane, so `fzf` has a real TTY. It reconstructs the layout tree from Herdr's flat `panes`/`splits` snapshot and moves panes into the destination by walking that tree.
- The script intentionally avoids focusing the moved tab after completion. Herdr may still choose a fallback focus if the active source tab empties.

## limitations

- This is an overlay terminal picker, not a native right-click menu. Herdr plugin v1 does not support native menu injection or non-terminal UI.
- There is no atomic `tab move` API, so this is implemented as multiple `pane move` calls. If a move fails after it starts, the plugin reports the failing command but does not currently roll back partial moves.
- Destination choices exclude the source workspace.

## development

```bash
npm test
```

That syntax-checks the JavaScript entrypoints and validates the plugin manifest is parseable TOML.

## publishing

1. create a GitHub repo, e.g. `AVGVSTVS96/herdr-tab-mover`
2. push this repo
3. add the GitHub topic `herdr-plugin`
4. users install with:

```bash
herdr plugin install AVGVSTVS96/herdr-tab-mover
```
