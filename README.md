# drovr

A [drover](https://en.wikipedia.org/wiki/Drover_(Australian)) moves herds between places. **drovr** does the same for your [herdr](https://herdr.dev) panes and tabs: move the focused tab to another workspace, or the focused pane into any tab, from a fuzzy picker in a floating popup.

Herdr has no built-in "move tab to workspace", and recreating a tab by replaying its layout would respawn every pane, killing running agents and shells. drovr relocates the *live* panes instead (`herdr pane move`), so everything keeps running exactly where it left off.

<img width="1104" height="640" alt="drovr picker" src="https://github.com/user-attachments/assets/3f5fecde-85fd-4221-b994-e3c54d16305d" />

## Features

- 🚚 **Move tabs** -- label, split layout, and every running pane relocate to another workspace
- 📦 **Move panes** -- send the focused pane into any tab, split right or down, or into a fresh tab or workspace
- 🤖 **Live agents survive** -- panes are relocated, never respawned
- 🎈 **Floating picker** -- theme-matched fzf popup; the tiled layout never shifts
- 🌐 **Cross-workspace** -- `ctrl-t` in the pane picker opens every workspace's tabs as destinations
- 🎯 **Focus follows** -- you land where your pane or tab just arrived
- ✅ **Verified moves** -- every move is checked against the server; failures surface right in the picker

## Requirements

- **herdr** `>= 0.7.4` -- the picker uses floating popup panels
- **node** `>= 23` -- runs the TypeScript sources directly via native type stripping; no build step
- **fzf** on `PATH` -- `brew install fzf` on macOS

## Install

```bash
herdr plugin install AVGVSTVS96/herdr-drovr
```

Herdr keybindings live in your config, not the plugin manifest, so add these to `~/.config/herdr/config.toml`:

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

Then reload:

```bash
herdr server reload-config
```

## Usage

**Move a tab** -- focus it, press `prefix+M`, pick a destination workspace.

**Move a pane** -- focus it, press `prefix+m`, pick a destination tab.

| key | action |
| --- | --- |
| type | filter destinations |
| `enter` | move (pane moves split **right**) |
| `alt-d` | move, splitting **down** (pane picker) |
| `ctrl-t` | toggle every workspace's tabs (pane picker) |
| `esc` | cancel |

Both pickers always offer `＋ new tab` / `＋ new workspace` rows below the real matches. A typed query becomes the new name, previewed live (`＋ new tab "api"`), while `enter` still lands on the best real match. If a move leaves the source tab or workspace empty, herdr closes it.

## How it works

Two scripts, zero runtime dependencies:

- **`open-picker.ts`** runs headless behind the keybinding: it resolves the focused pane and opens the picker popup with the move context in its environment.
- **`pick-and-move.ts`** runs inside the popup, where fzf has a real TTY. A popup is a session resource, not a pane in the source tab, so nothing pins the source layout and the moves run inline right after the pick.

A tab move reconstructs the layout tree from the rects herdr actually reported (no ratio arithmetic), re-validates that every source pane still exists after the pick, then replays the tree in the destination: one `pane move --new-tab`/`--new-workspace` for the anchor, then one `pane move --split` per split node with the exact direction and ratio. A pane move is a single `pane move --tab <id> --split right|down` into the destination's focused pane. Either way, the destination is focused the instant the popup closes.

There is no atomic `tab move` API, so a tab move is several `pane move` calls. Sources are re-validated right before moving; if a move still fails partway, drovr reports the failing command and does not roll back.

## Development

```bash
git clone https://github.com/AVGVSTVS96/herdr-drovr
herdr plugin link ./herdr-drovr
herdr plugin action list --plugin drovr

npm install   # dev-only: typescript for typechecking
npm test      # tsc --noEmit, then the layout-tree and picker-parsing tests
```

## License

[MIT](LICENSE)
