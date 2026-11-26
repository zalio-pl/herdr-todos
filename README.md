# Herdr Todos

A sidebar widget for the [Herdr](https://herdr.dev/) desktop app. **Todos** watches every [Pi](https://pi.dev/) conversation in the space you are looking at: a small, fast model reads each one and shows what it is doing, what is done and what is waiting on you. You never update it by hand.

This is John Lindquist's own widget from MEGA.dev S04E02 (Week 4, Day 2), where a widget is "an intelligent visualization of critical information": plain code gathers, a model judges. The lesson teaches you to build your own; this repository is the finished Herdr version, kept in step with the video so you can compare. Its companion from the same lesson is **Memories**, in its own repository: [herdr-memories](https://github.com/johnlindquist/herdr-memories). Each installs and works without the other.

## Requirements

| You need | Why | Without it |
|---|---|---|
| The [Herdr](https://github.com/herdrdev/herdr-app) desktop app with its command-line tools `herdr-app` and `hc` on your `PATH` (checked on Herdr 0.1.14) | The widget is a Herdr mod; `hc` lists the terminals of a space | `./install.sh` stops with "herdr-app was not found on your PATH" |
| [Pi](https://github.com/earendil-works/pi) on your `PATH`, logged in (checked on 1.5.0) | The widget reads Pi's conversations, and calls the model through `pi -p` | A card says "Not updated:" and why |
| [Node](https://nodejs.org/) 22 or newer (checked on 25.2.1) | The helper `todos.mjs` runs on Node | `./install.sh` stops with "node was not found on your PATH" |
| macOS | The only system this was checked on | Unverified |

Only Pi conversations are read. A pane running another harness is not listed.

**Model and cost.** Task lists are written by `anthropic/claude-haiku-5-5` unless you choose another (see [Settings](#settings)). Roughly one small-model call each time a conversation changes: about 4,000 to 6,000 tokens in, a few hundred out, well under one cent on the default. A conversation that has not changed is never sent again.

## Install

```sh
git clone https://github.com/johnlindquist/herdr-todos
cd herdr-todos
./install.sh
```

`install.sh` copies two mods into `~/.config/herdr-app/mods` (`todos` and its right-click menu `todos-menu`) and runs `herdr-app check` on each. You should see two lines that start with `check passed:`. Set `HERDR_APP_HOME` first to install into another Herdr home.

Herdr docks **Todos** on the right the first time it sees the mod.

- Update: `git pull`, then `./install.sh` again.
- Remove: delete the two folders from `~/.config/herdr-app/mods` and the Todos block from your layout file.
- With Memories too: install [herdr-memories](https://github.com/johnlindquist/herdr-memories); its `place-memories.mjs` puts Memories under Todos.

## Walkthrough, in the video's order

Do this in a Herdr space with Pi running in a pane. The sample project of the lesson is [RentAPlace](https://github.com/johnlindquist/rentaplace). The model's wording will differ on your machine.

1. **Look at Todos.** Each Pi conversation in the space you are looking at is one card: a coloured dot for its state, its title, one line saying what it is doing now, and its tasks. With no Pi in the space it says "No Pi sessions in this space" and "Start Pi in a tab here. Its tasks show up after the first reply."
2. **Ask Pi for something with a few steps**, for example: *"Plan how to add a cleaning fee to the booking price. Do not edit yet. Ask me whether it is per night or per stay."* When the reply finishes, the card fills in. In the check for this page, after the answer "per stay", the card was titled *"Cleaning fee plan"*, its now line read *"Plan confirmed; awaiting your go-ahead or a clarification before any edits"*, and it had three tasks: one done, one blocked, one to do.
3. **See what is waiting on you.** A conversation that is blocked on your answer gets a **Needs you** pill and sorts to the top. A working one has a pulsing dot. Finished tasks are ticked.
4. **Do nothing.** The card follows the conversation: it is read again when a reply finishes, when you send a new prompt, and at most every two minutes while the agent keeps working. The footer says "Updated just now" and names the model.
5. **Switch spaces.** Todos shows the conversations of the space in front of you. Every space's last list is saved, so it appears at once and then updates.
6. **Next in the video: Memories**, the widget under Todos, is [herdr-memories](https://github.com/johnlindquist/herdr-memories).

### What you should see

- Todos on the right edge of the window.
- One card per Pi conversation of this space, with a title, a "now" line and tasks. No card for other harnesses or for sub-agents.
- In the footer: when it was last updated, and the model that wrote the lists.

### Keys

Click inside the widget to give it the keyboard, or move to it the way you move between panes. Its keys are listed along its bottom edge while it has the keyboard, and every button's tooltip names its key.

| Key | What it does |
|---|---|
| **↑ ↓** or **k j** | Select a card |
| **Enter** | Go to that conversation |
| **R** | Update now |
| **Shift+F10**, or right-click | More actions |
| **Tab**, **Shift+Tab** | Next or previous widget |
| **−** | Collapse to one line, or expand |
| **Esc** | Back to the conversation you came from |

## Settings

One settings file, `~/.config/herdr-todos/config.json`, because a Herdr opened from the Dock has no shell environment. A project can override it with `<project>/.herdr/todos.json` (the project is the git repository a conversation runs in), so a team can pin a model. Later wins: defaults, then your file, then the project's file, then the environment.

| Key | Default | Meaning | Environment |
|---|---|---|---|
| `model` | `anthropic/claude-haiku-5-5` | The small model that writes each task list. Any `provider/id` from `pi --list-models`. | `HERDR_TODOS_MODEL` |
| `thinking` | `off` | Thinking level passed to the model: `off`, `low`, `medium`, `high`. | `HERDR_TODOS_THINKING` |
| `refreshSeconds` | `120` | A conversation that is still working gets its list rewritten at most this often (15 to 3600). | `HERDR_TODOS_REFRESH_SECONDS` |
| `maxTasksShown` | `8` | The most tasks kept per conversation from the model's list (1 to 20). | `HERDR_TODOS_MAX_TASKS_SHOWN` |
| `modelCmd` | none | A command run instead of Pi for every model call, as a list: `["node", "my-model.mjs"]`. It gets `{"model","system","input","thinking"}` as JSON on stdin and prints the reply. For another provider, or a recorded model in tests. | `HERDR_TODOS_MODEL_CMD` |

See and change them with the helper (installed at `~/.config/herdr-app/mods/todos/todos.mjs`):

```sh
node todos.mjs config                                   # every value and where it came from
node todos.mjs config set model anthropic/claude-sonnet-5-5
node todos.mjs config set refreshSeconds 60 --project   # writes <this git repository>/.herdr/todos.json
node todos.mjs config unset model
node todos.mjs config path                              # the two files
node todos.mjs describe                                 # every key with type, default and meaning (for agents)
```

An example file:

```json
{ "model": "anthropic/claude-haiku-5-5", "thinking": "off", "refreshSeconds": 120 }
```

`config set` checks the value before writing. A key the widget does not know, a value it cannot use, or a file that is not valid JSON is never silently ignored: the widget's footer says "Settings:" and what is wrong, and the defaults are used for those values. `HERDR_TODOS_CONFIG` names another settings file. The earlier file key `model_cmd` still works.

**When the small model gets it wrong.** A small model is fast and cheap, and sometimes overstates: a task marked done that is not, a "now" line that promises more than the conversation says. Try a larger one for a day, `node todos.mjs config set model anthropic/claude-sonnet-5-5`, and compare; it costs more per update and is slower. The model in use is always in the footer, and a failed call names the model and this command.

### Models through claude-bridge

If Pi reaches Claude through the [pi-claude-bridge](https://www.npmjs.com/package/pi-claude-bridge) extension (models named `claude-bridge/*`) rather than an API key, the default call cannot see those models: it runs `pi -p -ne`, and `-ne` turns extensions off. `examples/pi-bridge-model.mjs` is a `modelCmd` that makes the same call with only the bridge loaded:

```json
{
  "model": "claude-bridge/claude-haiku-5-5",
  "modelCmd": ["node", "<path-to>/herdr-todos/examples/pi-bridge-model.mjs"]
}
```

Herdr starts the widget without your shell's environment, so two things are fixed there. A missing `USER` (the bridge then says "Not logged in") is filled in from the system. A `PATH` that finds a Node Pi does not run on is yours to point elsewhere: copy `examples/pi-bridge-model.local.example.json` to `examples/pi-bridge-model.local.json` (git-ignored) and set `nodeBin` to the folder of a Node that works, or set `PI_BRIDGE_NODE_BIN`. The script holds no credentials; the login stays where the bridge keeps it. Try it by hand:

```sh
echo '{"model":"claude-bridge/claude-haiku-5-5","system":"Be brief.","input":"Reply with: ok","thinking":"off"}' | node examples/pi-bridge-model.mjs
```

## More than the video shows

- **Click a card** to go to that conversation. If you are zoomed in, the clicked pane is zoomed instead, so the view changes.
- **Drag a card** onto another to reorder. Your order comes first; conversations you have not placed follow, sorted by urgency (needs you, working, done).
- **Flag a task:** hover it and click the flag. Each click moves it from normal to high, then low, then back. High tasks are bold and sort first; low tasks are dimmed and sort last.
- **A conversation with a `todo` board** (the `todo` tool from [herdr-pi-todos](https://github.com/johnlindquist/herdr-pi-todos)) shows that board exactly, with no model call.
- The refresh button (top right) reads the space again and asks the model again for every conversation.
- **Right-click a task:** Explain this task, Go to session, and the two other priority levels. **Right-click a card:** Explain where it stands, Go to session, Move to top, Update now.
- **Explain** opens a new Pi to the right of the conversation's pane. It is a fork of that conversation (`pi --fork`): it starts with the whole history, while the original keeps going on its own. Its first message asks Pi to explain the task or conversation, then wait for you. The message also lists the commands that change the sidebar.
- **Spaces on other machines** are read on that machine: the helper is sent through `hc exec --on <machine>` to that machine's Node, so its conversations, its Pi login and its settings are used. It needs Node and Pi there.

**For agents.** `todos.mjs` is the whole interface; the widget calls it too. Output is one JSON document; errors are JSON on stderr with exit 1.

```sh
node todos.mjs describe
node todos.mjs show     --space <id>
node todos.mjs refresh  --space <id> [--force]
node todos.mjs order    --space <id> --terminals t8r,t90
node todos.mjs priority --space <id> --terminal t8r --task '<task key>' --level high
node todos.mjs explain  --space <id> --terminal t8r [--task '<task key>']
node todos.mjs config
```

Add `--state ~/.cache/herdr-todos/default` to read and change what the sidebar shows. Space ids come from `herdr-app status`.

## Move it, pop it out, close it

Todos has a title bar: its name, its own controls, then **Pop out** (↗) and **Close** (×). The keys work while Todos has the keyboard and are listed in its legend.

| You want | Pointer | Key | Command (for agents) |
|---|---|---|---|
| Put it above or below another widget | drag the title bar onto that widget: top half lands above, bottom half below | Shift+↑ / Shift+↓ (inside one column) | `herdr-app do todos.move-up`, `todos.move-down`, `todos.move-before:<widget>`, `todos.move-after:<widget>` |
| Move it to the other side of the window | drag the title bar, release on "Left side" or "Right side" in the widget | Shift+← / Shift+→ | `herdr-app do todos.move-left`, `todos.move-right` |
| Make it a free window | ↗ | Shift+O | `herdr-app do todos.popout` |
| Dock the window back | ↙ | Shift+O | `herdr-app do todos.dock` |
| Close it | × | Shift+W | `herdr-app do todos.close` |
| Open it again | command palette: `mod.open`, then `todos` | bind one in `keys.json`: `"cmd-shift-9": "mod.open:todos"` | `herdr-app do mod.open --name todos` |

- Esc cancels a drag. A drag nobody finishes is forgotten after 20 seconds.
- Moving changes your layout through Herdr's own `layout.set`. Herdr does not let anything rearrange its own layouts (Herdr, Terminals, Herdr 98): there the widget says so in one line. Duplicate the layout first (command palette: Duplicate layout), then move widgets in your copy. Pop out, dock and close work in every layout.
- The window remembers its spot and comes back on the next start. While it floats, the docked place is hidden; selection, scroll and collapse carry over.
- A closed widget is not loaded, so `todos.open` cannot reach it: reopening is Herdr's `mod.open`, which brings it back where it was (docked or floating). `mod.open` on an open window closes it.
- Only the copy on screen works. Closed, Todos reads nothing and calls no model; if it was shown earlier in this run, its two-second timer still wakes and returns at once.
- Agents read where it is from shared state `frame.todos` (in `shared.json` in the Herdr app's folder): `mode` (`docked`, `floating`, `closed`), `last`, `side`, `parent`, `index`, `above`, `below`, and `error` with a name (`shipped-layout`, `nothing-above`, `nothing-below`, `already-there`, `no-target`, `not-in-layout`, `already-floating`, `already-docked`, `unknown-move`).

## Troubleshooting

- **`./install.sh` says a mod failed its check.** The message names the file and the line. This page was checked on Herdr 0.1.14; update Herdr if yours is older.
- **Todos is not on the right after install.** Herdr docks it only the first time it sees the mod. Add `{ "type": "block", "content": { "mod": "todos" }, "size": { "px": 304 } }` to your layout's top row.
- **"No Pi sessions in this space".** Todos lists Pi only, in the space in front of you. Start Pi in a pane here.
- **A card says "Waiting for this session's first message".** Pi has not written a conversation yet. Send a prompt.
- **A card says "Not updated: …".** The model call failed; the last good list stays. The message names the model. Run `pi -p --model anthropic/claude-haiku-5-5 "hi"` in a terminal: if that fails, log in to Pi or pick a model you have with `node todos.mjs config set model <provider/id>`.
- **The footer says "Settings: …".** A settings file has an unknown key, a bad value, or is not valid JSON. `node todos.mjs config` lists each problem and the file it is in.
- **I updated from the version that held both widgets and Memories is gone.** Memories is now [herdr-memories](https://github.com/johnlindquist/herdr-memories); install it and your kept memories are carried over. `compose_model` in `~/.config/herdr-todos/config.json` is reported as unknown here: it belongs to Memories now (`composeModel`).
- **What does the helper see?** `node ~/.config/herdr-app/mods/todos/todos.mjs describe` prints the commands and the settings.

## How it is built

| File | What it holds |
|---|---|
| `main.js` | The Todos widget, drawn with Herdr's UI kit: you describe cards, buttons and lists in JavaScript and Herdr draws them natively. It decides when to update and calls the helper. |
| `todos.mjs` | The helper, plain Node with no dependencies: reads the settings, finds the Pi terminals of a space, matches each to its conversation file, calls the model, saves the lists. |
| `menu/main.js` | The right-click menu, installed as `todos-menu`. |
| `nav.js` | The keyboard and scrolling rules every sidebar widget of the lesson uses. |
| `mod.json` (two) | Where each mod first appears: Todos on the right; the menu only where the widget opens it. |
| `test/`, `fence.sh` | The tests, and one command that runs every check. |

**Shared copies.** [herdr-memories](https://github.com/johnlindquist/herdr-memories) is a separate repository, and each one is complete on its own. Three pieces are the same in both, copied rather than shared so you can read either repository alone: `nav.js`, `menu/main.js`, and the block between `// >>> shared block` and `// <<< shared block` in `todos.mjs` (the same block is in `memories.mjs`): settings, the model call, reading Pi's conversation files, and matching terminals to conversations. That block lives inside the helper, not in a file beside it, because for a space on another machine the helper is sent to that machine as one file. `test/shared.test.mjs` compares the copies when both repositories are checked out side by side.

How one update runs:

1. **Gather, in code.** `hc ls` and `hc get` list the live Pi terminals of the space. Each is matched to its Pi conversation file: by a `pi.session` label, by the session name Pi reports, by the file the same process used last time, or the newest file in that folder.
2. **Skip what has not changed.** A conversation file of the same size and state as last time is not sent to a model.
3. **Judge, with the small model.** The recent conversation goes to the model with one job: a title, a "now" line and a short task list as JSON. A `todo` board is used as it is instead.
4. **Save.** Lists are saved per space under `~/.cache/herdr-todos/`, and the widget draws from that.

## Build the same thing for another harness or workspace

The lesson's point is the idea, not this code: a small, light agent off to the side watches your conversations so you can see, at a glance, what each one is doing and what is waiting on you. You need two things:

- **From the harness:** where it stores conversations, and a way to call a model once from a command line with no tools. In Pi these are the session files under `~/.pi/agent/sessions/` and `pi -p`.
- **From the workspace:** a way to list the panes of the place you are looking at, and somewhere to draw. In Herdr that is `hc` and a mod drawn with the UI kit.

If your workspace has no UI kit, it probably has an extension or plugin system. Or show a web page from a dev server. Or build a terminal UI and leave it open in a pane; there are many good terminal UI libraries. There is no right or wrong way. `todos.mjs` does not draw anything, so it can feed any of them: `node todos.mjs refresh --space <id>` prints the lists as JSON.

A prompt to start from, in your harness repository:

> Build me a to-dos widget for my workspace. It watches every conversation in the space I am looking at. When a conversation changes, a small, fast model reads it and shows what it is doing, what is done and what is waiting on me. I never update it by hand. Give it one settings file where I can change the model.

To make widgets the way the lesson does, ask for a `/widget` command ([herdr-pi-widget](https://github.com/johnlindquist/herdr-pi-widget)), grow each widget in the lab ([herdr-pi-lab](https://github.com/johnlindquist/herdr-pi-lab)) from a hello world up to what you need, then install it and pin it to the side. The other widgets of the same lesson are [herdr-memories](https://github.com/johnlindquist/herdr-memories) and the Issues widget, [herdr-triage](https://github.com/johnlindquist/herdr-triage).

## Tested

What was checked for 0.2.0 on 2026-11-15 (macOS, Herdr 0.1.14, Pi 1.5.0, Node 25.2.1), and how:

- **Clean install, without Memories.** A fresh clone of this repository, `./install.sh` into an empty Herdr home (`HERDR_APP_HOME`): `herdr-app check` passed for `todos` and `todos-menu`, and nothing else was in that home.
- **The checks.** From the same clone, `npm install` and `npm run check`: syntax, types of the navigation rules and the tests passed (settings order, unknown key, broken file, `config set`; the comparison with herdr-memories runs only when it is checked out beside this repository, and passed there).
- **The helper, end to end, on a fresh clone of RentAPlace.** A real Pi conversation on `anthropic/claude-haiku-5-5` asked for the cleaning-fee plan and was answered "per stay". A small script stood in for `hc` and reported that one terminal, so Herdr's own terminal list was not exercised. With the installed helper and a real model call, `refresh` returned the card quoted in the walkthrough; `explain` printed the command for the forked Pi; a model id that does not exist produced "anthropic/no-such-model failed: 404 … Another model: node todos.mjs config set model <provider/id>".
- **With Memories in the same Herdr home:** all four mods passed `herdr-app check`.
- **Not checked for this version:** the widget drawn in a Herdr window installed from a clean clone, spaces on other machines, and Node 22 to 24.

```sh
npm install
npm run check
```

Moving, popping out and closing (2026-11-15): `frame.js` has 12 tests that run without Herdr (where a drop lands, how the layout is rewritten, what is remembered, one engine). In a second, separate Herdr window on a duplicated layout, through commands, with the layout read back each time: reorder, move to the other side and back, pop out (window open, docked place hidden), dock back, close and reopen with `mod.open`, docked and floating. Not run: a real drag with the pointer, and the Shift keys pressed by hand.

## License

[MIT](LICENSE)
