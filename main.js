// Todos: the task lists of the Pi sessions in the shown space, kept up to date in the background.
// The work happens in todos.mjs (Node): it maps terminals to Pi journals, reads `todo` boards and
// asks a small model to summarize the rest. This view decides when to refresh and draws the result.
// Every space's last result is cached on disk, so switching spaces shows it at once.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, focused, panes, exec, home, appHome, run, theme, readTextFile, nextCommand, shared, setShared, openOverlay, closeOverlay, props, layout } from "herdr";
import { step, widgetDirection, COLLAPSE_KEY, loadCollapsed, applyCollapse, returnTarget, tip, keepInView, wheelTop, maxTop, fitCount, estimateViewport } from "./nav.js";
import { createFrame, frameParts } from "./frame.js";

const NAME = "todos";
const ICON = (n) => `mods/${NAME}/icons/${n}.svg`;
const helper = () => `${appHome()}/mods/${NAME}/todos.mjs`;
const stateDir = () => {
  const app = appHome();
  const key = app === `${home()}/.config/herdr-app` ? "default" : app.replace(/[^A-Za-z0-9]/g, "_");
  return `${home()}/.cache/herdr-todos/${key}`;
};
// Spaces on another machine ("m1/sp…") are read there: the helper is piped through herdr-core to
// that machine's Node, so its Pi journals, git roots and model logins stay on it and
// both ends always run this same version of the helper.
const REMOTE_STATE = "~/.cache/herdr-todos/remote";
const where = (space) => {
  const i = space.indexOf("/");
  return i < 0 ? { machine: null, id: space } : { machine: space.slice(0, i), id: space.slice(i + 1) };
};
function callHelper(machine, argv, timeout) {
  if (!machine) return exec("node", [helper(), ...argv, "--state", stateDir()], { timeout });
  return exec("sh", ["-c", 'm="$1"; shift; exec hc exec --on "$m" -i node --input-type=module - "$@" < "$0"', helper(), machine, ...argv, "--state", REMOTE_STATE], { timeout });
}
function helperError(r, machine) {
  const text = r.stderr.trim();
  if (machine && /cannot start node|node: (command )?not found|exec: node/i.test(text)) return `${machine} needs Node and Pi for Todos`;
  try {
    const e = JSON.parse(text.split("\n").pop());
    return typeof e.message === "string" ? e.message : e.error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || `exit ${r.code}`;
  }
}
// The helper on a machine knows its terminals as "t7"; this window knows them as "m1/t7".
function fromMachine(doc, machine) {
  if (!machine || !doc) return doc;
  const q = (a) => `${machine}/${a}`;
  return {
    ...doc,
    sessions: (doc.sessions ?? []).map((x) => ({ ...x, terminal: q(x.terminal) })),
    prefs: doc.prefs && {
      order: (doc.prefs.order ?? []).map(q),
      priority: Object.fromEntries(Object.entries(doc.prefs.priority ?? {}).map(([k, v]) => [q(k), v])),
    },
  };
}
const bare = (addr, machine) => (machine && addr.startsWith(`${machine}/`) ? addr.slice(machine.length + 1) : addr);
const stateFile = (space) => `${stateDir()}/spaces/${space.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;

const PERIODIC_MS = 60_000; // the shown space, while a session in it works
const QUIET_MS = 10 * 60_000; // the shown space, otherwise
const RANK = { blocked: 0, error: 0, working: 1, done: 2, idle: 3 };
const TASK_ORDER = { blocked: 0, in_progress: 1, todo: 2, done: 3 };
const LEVEL = { high: 0, normal: 1, low: 2 };

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Pi titles its terminal "π - <session name> - <folder>".
const cleanTitle = (x) => (x ?? "").replace(/^π\s*-\s*/, "").replace(/\s+-\s+[^-]+$/, "").trim();

// Focuses a pane so it is actually seen. A zoomed tab keeps showing its zoomed pane when another
// pane gets focus, so: if the person is zoomed in now, or the pane's tab is zoomed on another
// pane, zoom the clicked pane instead.
function showPane(pane) {
  const all = panes();
  const target = all.find((p) => p.pane === pane);
  if (!target) return run("pane.focus", { pane });
  const zoomedNow = all.some((p) => p.focused && p.zoomed);
  const zoomedThere = all.find((p) => p.tab === target.tab && p.zoomed);
  const siblings = all.filter((p) => p.tab === target.tab).length;
  run("pane.focus", { pane });
  if (siblings > 1 && !target.zoomed && (zoomedNow || zoomedThere)) run("pane.zoom", { pane });
}

// The right-click menu (mods/todos-menu): items are { label, icon, action, args, sep? }; the
// choice comes back as the "menu" command with shared "todos.menu" = { action, args, at }.
const CHROME = (n) => `mods/workspace-chrome/${n}.svg`;
function openMenu(owner, title, items, width = 250) {
  const seps = items.filter((it, i) => i > 0 && it.sep).length;
  openOverlay({ mod: "todos-menu", kind: "popup", width, height: 12 + items.length * 31 + seps * 9 + (title ? 24 : 0), props: { owner, title, items } });
}

// Opens argv in a new pane right of the terminal's pane (else the focused one). A zoomed tab
// would hide the new pane, so it is unzoomed first.
function splitBeside(terminal, argv) {
  const all = panes();
  const f = focused();
  const target =
    all.find((p) => p.terminal === terminal) ??
    all.find((p) => p.pane === f?.pane) ??
    all.find((p) => p.tab === f?.tab && p.terminal);
  if (!target) return "No pane to open it beside";
  const zoomed = all.find((p) => p.tab === target.tab && p.zoomed);
  if (zoomed) run("pane.zoom", { pane: zoomed.pane });
  run("pane.split", { pane: target.pane, direction: "right", argv });
  return null;
}

// The kit cannot measure text, so wrapped lines are counted: greedy word wrap with a generous
// average glyph width (counting a line too many leaves a little space; too few would clip).
const GLYPH = 0.53; // Geist measures about 0.49 em per character in Polish and English text
function lineCount(text, width, size) {
  const per = Math.max(8, Math.floor(width / (size * GLYPH)));
  let lines = 1;
  let used = 0;
  for (const word of String(text ?? "").split(/\s+/).filter(Boolean)) {
    let w = word.length;
    if (used > 0 && used + 1 + w <= per) {
      used += 1 + w;
      continue;
    }
    if (used > 0) lines++;
    while (w > per) {
      lines++;
      w -= per;
    }
    used = w;
  }
  return lines;
}
// Line heights and text widths of a card, from the list's width (card margins, padding, icons).
const LH = { now: 17, task: 18, error: 15 };
const textWidths = (listW) => ({ now: listW - 58, task: listW - 89, error: listW - 58 });

const statusClass = (s) => (s === "working" ? "working" : s === "blocked" || s === "error" ? "blocked" : "rest");

// The list shows items from `top` and clips the rest; ↑/↓ and the wheel move `top` only as
// needed (the rules and their tests are in nav.js). Shared shape across the three widgets.
function windowedList(view, t, id, heights, render, chromePx, mod) {
  const vp = view.viewH ?? estimateViewport(layout(), mod, windowHeight(), chromePx);
  view.lastHeights = heights;
  view.lastVp = vp;
  view.top = Math.min(view.top ?? 0, maxTop(heights, vp));
  const shown = fitCount(heights, view.top, vp);
  const more = heights.length > shown;
  const list = div()
    .id(id)
    .flex_1()
    .min_h(60)
    .overflow_hidden()
    .relative()
    .on_mouse_move((e, cx) => {
      if (e.bounds?.height) view.viewH = e.bounds.height;
      if (e.bounds?.width && Math.abs(e.bounds.width - (view.viewW ?? 0)) > 1) {
        view.viewW = e.bounds.width;
        cx.notify();
      }
    })
    .on_scroll_wheel((e, cx) => {
      if (e.bounds?.height) view.viewH = e.bounds.height;
      view.top = wheelTop(view.top, e.delta.y, heights, view.viewH ?? vp);
      cx.notify();
    })
    .child(v_flex().children(heights.slice(view.top, view.top + shown + 1).map((h, j) => div().h(h).flex_none().child(render(view.top + j)))));
  return v_flex()
    .flex_1()
    .min_h(76)
    .child(list)
    .when(more, (el) => el.child(div().flex_none().h(16).px(14).text_size(10).text_color(t.dim).child(`Showing ${view.top + 1}–${Math.min(heights.length, view.top + shown)} of ${heights.length} · scroll or ↑↓`)));
}

const windowHeight = () => {
  try {
    return /** @type {any} */ (globalThis).window?.viewport_size?.().height ?? 900;
  } catch {
    return 900;
  }
};

// The key legend under the list (the same shape in Issues, Todos and Memories).
function legend(t, keys) {
  return h_flex()
    .flex_none()
    .px(12)
    .py(5)
    .gap_x(8)
    .gap_y(3)
    .flex_wrap()
    .border_t(1)
    .border_color(t.border)
    .children(
      keys.map(([k, label]) =>
        h_flex()
          .id(`legend-${label}`)
          .gap(4)
          .items_center()
          .tooltip(tip({ Next: "Next widget", Back: "Back to Main", Select: "Select" }[label] ?? label, k))
          .child(div().px(4).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.foreground).child(k))
          .child(div().text_size(10.5).text_color(t.dim).child(label)),
      ),
    );
}

export default class Todos extends View {
  init(_props, cx) {
    this.cache = {}; // space id -> last helper document
    this.busy = new Set(); // spaces being refreshed
    this.again = new Set(); // spaces to refresh once more when the current run ends
    this.scheduled = new Set();
    this.waiting = []; // spaces queued behind the two running refreshes
    this.prefs = {}; // space id -> { order, priority } as the person set them
    this.editedAt = {}; // space id -> ms of the last edit here
    this.pressed = null; // the card being dragged
    this.over = null;
    this.hoverTask = null;
    this.errors = {}; // space id -> helper error text
    this.lastRun = {}; // space id -> ms of the last finished refresh
    this.seen = null; // pi agent address -> status class, from the last tick
    this.shownSpace = null;
    this.collapsed = loadCollapsed(localStorage, NAME);
    this.handle = cx.focus_handle();
    this.top = 0;
    this.viewH = null;
    this.viewW = null;
    this.widths = textWidths(304);
    this.lastHeights = null; // the list's row heights and height, from the last render
    this.lastVp = 0;
    this.sel = null; // the selected card's terminal address
    this.before = null; // what had the keyboard before this widget took it
    // Title bar, move, pop out, close: the shared rules in frame.js. Only the copy on screen works.
    this.frame = createFrame({ mod: NAME, h: { layout, run, shared, setShared, openOverlay, closeOverlay, props } });
    const carried = this.frame.start();
    if (carried) {
      this.sel = carried.sel ?? null;
      this.top = carried.top ?? 0;
      if (typeof carried.collapsed === "boolean") this.collapsed = carried.collapsed;
    }
    if (this.frame.floating) this.handle.focus();
    this.tick(cx);
    cx.timer.every(2000, (cx) => this.tick(cx));
    cx.timer.every(PERIODIC_MS, (cx) => {
      this.periodic(cx);
      cx.notify(); // the "3m" ages
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh" && this.shownSpace) this.refresh(this.shownSpace, cx, true);
        else if (c === "menu") this.menuChoice(cx);
        else if (c === "focus") this.takeKeyboard();
        else this.command(c, cx);
        cx.notify();
      }
    });
  }

  // Watches the live agent list (no redraw unless something changed) and queues refreshes:
  // the shown space when it changes, any space whose Pi session changed state.
  tick(cx) {
    this.frame.check();
    if (!this.frame.active()) return (this.seen = null);
    const sp = focused()?.space ?? null;
    if (sp && sp !== this.shownSpace) {
      this.shownSpace = sp;
      if (!this.cache[sp]) this.load(sp, cx);
      this.want(sp, cx, 0);
      cx.notify();
    }
    const now = new Map();
    for (const a of agents()) if (a.app === "pi") now.set(a.address, { cls: statusClass(a.status), space: a.space });
    if (this.seen) {
      for (const [addr, v] of now) {
        const before = this.seen.get(addr);
        // A new prompt is written a moment after the run starts; a finished reply right away.
        if (before === undefined) this.want(v.space, cx, 4000);
        else if (before.cls !== v.cls) this.want(v.space, cx, v.cls === "working" ? 6000 : 1500);
      }
      for (const [addr, v] of this.seen) if (!now.has(addr)) this.want(v.space, cx, 500);
    }
    this.seen = now;
    if (!this.warmed && now.size) {
      this.warmed = true;
      this.warm(cx);
    }
  }

  periodic(cx) {
    const sp = this.shownSpace;
    if (!sp || !this.frame.active()) return;
    const working = agents().some((a) => a.space === sp && a.app === "pi" && a.status === "working");
    const since = Date.now() - (this.lastRun[sp] ?? 0);
    if (working || since > QUIET_MS) this.want(sp, cx, 0);
  }

  want(space, cx, delay) {
    if (!space || this.scheduled.has(space)) return;
    this.scheduled.add(space);
    cx.timer.after(Math.max(16, delay), (cx) => {
      this.scheduled.delete(space);
      this.refresh(space, cx, false);
    });
  }

  // Fills the cache for every space with a Pi session, one after another, so a first visit
  // to a space already has its lists.
  warm(cx) {
    const ids = [...new Set(agents().filter((a) => a.app === "pi").map((a) => a.space))];
    ids.filter((id) => id !== this.shownSpace).forEach((id, i) => this.want(id, cx, 3000 + i * 2500));
  }

  load(space, cx) {
    const { machine, id } = where(space);
    cx.spawn(async (cx) => {
      try {
        let doc = null;
        if (!machine) {
          const text = await readTextFile(stateFile(space));
          doc = text ? JSON.parse(text) : null;
        } else {
          const r = await callHelper(machine, ["show", "--space", id], 60_000);
          if (r.code === 0) doc = fromMachine(JSON.parse(r.stdout), machine);
        }
        if (doc && doc.state !== "missing" && !this.cache[space]) {
          this.cache[space] = doc;
          cx.notify();
        }
      } catch {}
    });
  }

  refresh(space, cx, force) {
    if (!this.frame.active()) return; // hidden or closed: no reading, no model calls
    if (this.busy.has(space)) {
      this.again.add(space);
      return;
    }
    if (this.busy.size >= 2 && !force) {
      // At most two at once; the rest wait their turn (the shown space first).
      if (!this.waiting.includes(space)) space === this.shownSpace ? this.waiting.unshift(space) : this.waiting.push(space);
      return;
    }
    this.busy.add(space);
    if (space === this.shownSpace) cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { machine, id } = where(space);
        const argv = ["refresh", "--space", id];
        if (force) argv.push("--force");
        const r = await callHelper(machine, argv, 300_000);
        if (r.code === 0) {
          const doc = fromMachine(JSON.parse(r.stdout), machine);
          if (!doc.busy) {
            this.cache[space] = doc;
            // Adopt saved choices (an agent may have set them) unless edited here since this read began.
            if (!(this.editedAt[space] > (doc.updated_at ?? 0))) delete this.prefs[space];
          }
          delete this.errors[space];
        } else this.errors[space] = helperError(r, machine);
      } catch (e) {
        this.errors[space] = String(e?.message ?? e);
      }
      this.lastRun[space] = Date.now();
      // The Memories widget, when it is installed too, takes this as a cue to look for new prompts.
      setShared("todos.updated", { ...(shared("todos.updated") ?? {}), [space]: Date.now() });
      this.busy.delete(space);
      if (this.again.delete(space)) this.refresh(space, cx, false);
      const next = this.waiting.shift();
      if (next) this.refresh(next, cx, false);
      cx.notify();
    });
  }

  // ---------- the person's order and priorities ----------

  prefsFor(space) {
    if (!this.prefs[space]) {
      const p = this.cache[space]?.prefs;
      if (!p) return { order: [], priority: {} };
      this.prefs[space] = { order: [...(p.order ?? [])], priority: { ...(p.priority ?? {}) } };
    }
    return this.prefs[space];
  }

  // Saves through the helper, so its CLI, cache and this view agree. Shown at once; saved after.
  save(space, argv, cx) {
    this.editedAt[space] = Date.now();
    cx.spawn(async (cx) => {
      try {
        const { machine, id } = where(space);
        const r = await callHelper(machine, [...argv, "--space", id], 60_000);
        if (r.code !== 0) this.errors[space] = `Couldn't save: ${helperError(r, machine)}`;
        else delete this.errors[space];
      } catch (e) {
        this.errors[space] = `Couldn't save: ${String(e?.message ?? e)}`;
      }
      cx.notify();
    });
  }

  move(from, to, cx) {
    const sp = this.shownSpace;
    const list = [...(this.shownOrder ?? [])];
    const fromAt = list.indexOf(from);
    const toAt = list.indexOf(to);
    if (!sp || fromAt < 0 || toAt < 0) return;
    list.splice(fromAt, 1);
    list.splice(fromAt < toAt ? list.indexOf(to) + 1 : list.indexOf(to), 0, from);
    this.prefs[sp] = { ...this.prefsFor(sp), order: list };
    this.save(sp, ["order", "--terminals", list.map((a) => bare(a, where(sp).machine)).join(",")], cx);
  }

  setPriority(terminal, key, level, cx) {
    const sp = this.shownSpace;
    if (!sp || !terminal || !key) return;
    const prefs = this.prefsFor(sp);
    const k = `${terminal}|${key}`;
    const priority = { ...prefs.priority };
    if (level === "normal") delete priority[k];
    else priority[k] = level;
    this.prefs[sp] = { ...prefs, priority };
    this.save(sp, ["priority", "--terminal", bare(terminal, where(sp).machine), "--task", key, "--level", level], cx);
    cx.notify();
  }

  // ---------- right-click menus ----------

  taskMenu(a, s, task) {
    const sp = this.shownSpace;
    const terminal = a?.address ?? s?.terminal;
    const level = task.priority ?? "normal";
    const items = [
      { label: "Explain this task", icon: CHROME("panel-right"), action: "explain", args: { space: sp, terminal, task: task.key } },
      { label: "Go to session", icon: CHROME("terminal"), action: "focus", args: { terminal, pane: a?.pane ?? null } },
    ];
    if (task.key && task.status !== "done") {
      const set = (lv, label, icon) => ({ label, icon, action: "priority", args: { terminal, key: task.key, level: lv } });
      const levels = [set("high", "High priority", ICON("flag-on")), set("normal", "Normal priority", ICON("flag")), set("low", "Low priority", ICON("low"))].filter((it) => it.args.level !== level);
      levels[0].sep = true;
      items.push(...levels);
    }
    openMenu(NAME, task.text, items);
  }

  cardMenu(a, s) {
    const sp = this.shownSpace;
    const terminal = a?.address ?? s?.terminal;
    const items = [
      { label: "Explain where it stands", icon: CHROME("panel-right"), action: "explain", args: { space: sp, terminal } },
      { label: "Go to session", icon: CHROME("terminal"), action: "focus", args: { terminal, pane: a?.pane ?? null } },
      { label: "Move to top", icon: CHROME("pin"), action: "top", args: { terminal }, sep: true },
      { label: "Update now", icon: ICON("refresh"), action: "refresh", args: {} },
    ];
    openMenu(NAME, s?.title || s?.name || cleanTitle(a?.title) || "Pi session", items);
  }

  menuChoice(cx) {
    const m = shared(`${NAME}.menu`);
    if (!m || m.at === this.menuSeen) return;
    this.menuSeen = m.at;
    const sp = this.shownSpace;
    const a = m.args ?? {};
    if (m.action === "explain") this.explain(a.space ?? sp, a.terminal, a.task ?? null, cx);
    else if (m.action === "focus") {
      const pane = a.pane ?? panes().find((p) => p.terminal === a.terminal)?.pane;
      if (pane) showPane(pane);
      else run("agent.focus", { terminal: a.terminal });
    } else if (m.action === "priority") this.setPriority(a.terminal, a.key, a.level, cx);
    else if (m.action === "top") {
      const list = this.shownOrder ?? [];
      if (sp && list.includes(a.terminal)) {
        const order = [a.terminal, ...list.filter((x) => x !== a.terminal)];
        this.prefs[sp] = { ...this.prefsFor(sp), order };
        this.save(sp, ["order", "--terminals", order.map((x) => bare(x, where(sp).machine)).join(",")], cx);
      }
    } else if (m.action === "refresh" && sp) this.refresh(sp, cx, true);
    else if (m.action === "model" && a.model) this.setModel(a.space ?? sp, a.model, cx);
    cx.notify();
  }

  // ---------- the model that writes the lists ----------

  // Asks the helper (on the space's machine) which models Pi has, then opens them as a menu.
  modelMenu(cx) {
    const sp = this.shownSpace;
    if (!sp) return;
    const { machine } = where(sp);
    this.notice = "Reading the models…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await callHelper(machine, ["models"], 60_000);
        if (r.code !== 0) this.errors[sp] = `Couldn't list the models: ${helperError(r, machine)}`;
        else {
          const { current, models } = JSON.parse(r.stdout);
          if (!models.length) this.errors[sp] = "Pi lists no models (pi --list-models)";
          else {
            const providers = new Set(models.map((m) => m.split("/")[0]));
            const items = models.map((m, i) => {
              const [provider, ...rest] = m.split("/");
              const id = rest.join("/");
              return {
                label: providers.size > 1 ? `${id}  ·  ${provider}` : id,
                icon: m === current ? ICON("done") : null,
                action: "model",
                args: { space: sp, model: m },
                sep: i > 0 && models[i - 1].split("/")[0] !== provider,
              };
            });
            openMenu(NAME, `Task lists by ${current}`, items, providers.size > 1 ? 300 : 250);
          }
        }
      } catch (e) {
        this.errors[sp] = `Couldn't list the models: ${String(e?.message ?? e)}`;
      }
      this.notice = null;
      cx.notify();
    });
  }

  // Saves the model in the user settings file (of the space's machine) and reads the space again:
  // a list written by another model is written anew.
  setModel(space, model, cx) {
    if (!space || !model) return;
    const { machine } = where(space);
    if (this.cache[space]?.model === model) return;
    this.notice = `Switching to ${model.split("/").pop()}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await callHelper(machine, ["config", "set", "model", model], 60_000);
        if (r.code !== 0) this.errors[space] = `Couldn't change the model: ${helperError(r, machine)}`;
        else {
          delete this.errors[space];
          for (const [id, doc] of Object.entries(this.cache)) if (doc && where(id).machine === machine) this.cache[id] = { ...doc, model };
          this.notice = null;
          this.refresh(space, cx, false);
        }
      } catch (e) {
        this.errors[space] = `Couldn't change the model: ${String(e?.message ?? e)}`;
      }
      this.notice = null;
      cx.notify();
    });
  }

  // A new Pi beside the session, on a fork of its conversation, asked to explain (see `explain`
  // in todos.mjs, which builds the command on the session's own machine).
  explain(space, terminal, task, cx) {
    if (!space || !terminal) return;
    const { machine, id } = where(space);
    this.notice = "Opening a Pi to explain…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const argv = ["explain", "--space", id, "--terminal", bare(terminal, machine)];
        if (task) argv.push("--task", task);
        const r = await callHelper(machine, argv, 60_000);
        if (r.code !== 0) this.errors[space] = `Couldn't open: ${helperError(r, machine)}`;
        else {
          const why = splitBeside(terminal, JSON.parse(r.stdout).argv);
          if (why) this.errors[space] = why;
          else delete this.errors[space];
        }
      } catch (e) {
        this.errors[space] = `Couldn't open: ${String(e?.message ?? e)}`;
      }
      this.notice = null;
      cx.notify();
    });
  }

  // ---------- keyboard: the shared rules in nav.js ----------

  takeKeyboard() {
    const f = focused();
    if (!this.handle.is_focused() && f && (f.pane || f.terminal)) this.before = { pane: f.pane, terminal: f.terminal };
    if (this.collapsed) this.setCollapsed(false);
    this.handle.focus();
    this.reveal();
  }

  // What the next copy (the window, or the docked block again) starts from.
  viewState() {
    return { sel: this.sel, top: this.top, collapsed: this.collapsed };
  }

  close() {
    this.frame.closed();
  }

  // Takes the keyboard without expanding or scrolling (a press on the title bar).
  takeKeyboardQuietly() {
    const f = focused();
    if (f && (f.pane || f.terminal)) this.before = { pane: f.pane, terminal: f.terminal };
    this.handle.focus();
  }

  setCollapsed(on) {
    this.collapsed = on;
    if (this.frame.floating) return; // a window has no column to give its height to
    applyCollapse({ mod: NAME, collapsed: on, storage: localStorage, layout, run });
  }

  reveal() {
    const at = (this.shownOrder ?? []).indexOf(this.sel);
    if (at >= 0 && this.lastHeights) this.top = keepInView(this.top, at, this.lastHeights, this.lastVp);
  }

  /** Keys and commands share one path. Returns true when handled. */
  command(k, cx) {
    if (k === "escape" && this.frame.dragging() === "mine") return (this.frame.dragCancel(), true);
    if (this.frame.command(k, this.viewState())) return true;
    if (k === "escape") {
      const t = returnTarget(this.before, null);
      this.before = null;
      if (t) run("pane.focus", t);
      return true;
    }
    if (k === COLLAPSE_KEY || k === "collapse") return (this.setCollapsed(!this.collapsed), true);
    if (k === "r") return (this.shownSpace && this.refresh(this.shownSpace, cx, true), true);
    const dir = widgetDirection(k);
    if (dir) return (run("pane.go", { direction: dir }), true);
    if (this.collapsed) return false;
    const list = this.shownOrder ?? [];
    const at = Math.max(0, list.indexOf(this.sel));
    const next = step(at, list.length, k);
    if (next != null) {
      this.sel = list[next];
      this.reveal();
      return true;
    }
    const a = agents().find((x) => x.address === (list.includes(this.sel) ? this.sel : list[0]));
    if (k === "enter" && a) {
      showPane(a.pane);
      return true;
    }
    if ((k === "shift-f10" || k === "menu-key") && a) {
      const s = this.cache[this.shownSpace]?.sessions?.find((x) => x.terminal === a.address);
      this.cardMenu(a, s);
      return true;
    }
    return false;
  }

  // ---------- drawing ----------

  statusColor(t, s) {
    return s === "working" ? t.working : s === "blocked" || s === "error" ? t.blocked : s === "done" ? t.done : t.idle;
  }

  dot(t, status) {
    const d = div().w(8).h(8).rounded(4).flex_none().bg(this.statusColor(t, status));
    return status === "working" ? d.loop("opacity", { from: 0.3, to: 1, period: 1400 }) : d;
  }

  taskRow(t, task, i, key, terminal, onMenu) {
    const s = task.status;
    const level = task.priority ?? "normal";
    const rowId = `${key}-t${i}`;
    const icon =
      s === "in_progress"
        ? svg(ICON("spinner")).size(13).flex_none().text_color(t.working).spin(1100)
        : s === "done"
          ? svg(ICON("done")).size(13).flex_none().text_color(t.done)
          : s === "blocked"
            ? svg(ICON("blocked")).size(13).flex_none().text_color(t.blocked)
            : svg(ICON("todo")).size(13).flex_none().text_color(t.dim);
    const low = level === "low" && s !== "done";
    const text = div()
      .flex_1()
      .min_w(0)
      .text_size(12.5)
      .text_color(s === "done" || low ? t.dim : s === "todo" ? t.muted : s === "blocked" ? t.blocked : t.foreground)
      .when(level === "high" && s !== "done", (el) => el.font_medium().text_color(s === "blocked" ? t.blocked : t.foreground))
      .line_height(`${LH.task}px`)
      .child(task.text);
    const lines = lineCount(task.text, this.widths.task, 12.5);
    // The flag: shown when set, or on hover. Click: normal -> high -> low -> normal.
    const showFlag = s !== "done" && task.key && (level !== "normal" || this.hoverTask === rowId);
    const flag = div()
      .id(`${rowId}-flag`)
      .flex_none()
      .mt(1)
      .p(2)
      .rounded(4)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(level === "high" ? "High priority (click: low)" : level === "low" ? "Low priority (click: normal)" : "Mark high priority")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.setPriority(terminal, task.key, level === "normal" ? "high" : level === "high" ? "low" : "normal", cx);
      })
      .child(
        level === "low"
          ? svg(ICON("low")).size(12).text_color(t.dim)
          : svg(ICON(level === "high" ? "flag-on" : "flag")).size(12).text_color(level === "high" ? t.ansi3 ?? t.working : t.dim),
      );
    return h_flex()
      .id(rowId)
      .h(LH.task * lines)
      .gap(8)
      .items_start()
      .tooltip(`${task.text}\n\nRight-click: explain, go to session, priority`)
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        onMenu(task);
      })
      .on_hover((on, cx) => {
        if (on) this.hoverTask = rowId;
        else if (this.hoverTask === rowId) this.hoverTask = null;
        cx.notify();
      })
      .child(div().pt(2).flex_none().child(icon))
      .child(text)
      .child(showFlag ? flag : div().w(16).flex_none());
  }

  // What a card shows, and so its exact height: the list is virtual and places cards by it.
  // The title and tab are one line (truncated; full text in the tooltip); the now line, the tasks
  // and the error wrap, and the height counts their lines (`lineCount`).
  shape(a, s, busy, showTab) {
    const sorted = [...(s?.tasks ?? [])].sort(
      (x, y) => (TASK_ORDER[x.status] ?? 9) - (TASK_ORDER[y.status] ?? 9) || (LEVEL[x.priority] ?? 1) - (LEVEL[y.priority] ?? 1),
    );
    // Glanceable: everything active or high, the next few, the latest couple done.
    const pick = (st, n) => sorted.filter((x) => x.status === st).filter((x, i) => i < n || x.priority === "high");
    const tasks = [...pick("blocked", 9), ...pick("in_progress", 9), ...pick("todo", 3), ...pick("done", 2)];
    const hidden = sorted.length - tasks.length;
    // Only when it tells sessions apart: a named tab, or sessions spread over several tabs.
    const tabLabel = !a ? null : a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : showTab ? `Tab ${a.tab_index}` : null;
    const placeholder = !s ? (busy ? "Reading this session…" : "Not read yet") : !tasks.length && !s.now ? (s.error ? null : "No tasks yet") : null;
    const w = this.widths;
    const taskPx = tasks.reduce((n, x) => n + LH.task * lineCount(x.text, w.task, 12.5), 0);
    const parts = [
      tabLabel ? 14 : 0,
      s?.now ? 7 + LH.now * lineCount(s.now, w.now, 12) : 0,
      tasks.length ? 6 + taskPx + (tasks.length - 1) * 5 + 7 : 0,
      hidden > 0 ? 22 : 0,
      placeholder ? 24 : 0,
      s?.error ? 7 + LH.error * lineCount(`Not updated: ${s.error}`, w.error, 11) : 0,
    ];
    return { tasks, hidden, tabLabel, placeholder, height: 22 + 20 + parts.reduce((n, x) => n + x, 0) };
  }

  card(t, a, s, busy, showTab, dropBelow) {
    const addr = a?.address ?? s?.terminal;
    const status = a?.status ?? s?.status ?? "idle";
    const title = s?.title || s?.name || cleanTitle(a?.title) || "Pi session";
    const { tasks, hidden, tabLabel, placeholder, height } = this.shape(a, s, busy, showTab);
    const key = `c-${a?.address ?? s?.terminal}`;
    const needsYou = status === "blocked";
    const selected = addr === this.sel && this.handle.is_focused();
    const sourceIcon =
      s?.source === "board"
        ? svg(ICON("board")).size(11).flex_none().text_color(t.dim)
        : s?.source === "haiku"
          ? svg(ICON("sparkle")).size(11).flex_none().text_color(t.dim)
          : null;
    return v_flex()
      .id(key)
      .flex_none()
      .h(height)
      .overflow_hidden()
      .p(10)
      .gap(7)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(selected ? t.accent : needsYou ? t.blocked : a?.focused ? t.input : t.border)
      .tooltip(`${title}${s?.now ? `\n${s.now}` : ""}\n\n${tip("Go to session", "Enter")} · drag to reorder · right-click or ⇧F10 for more`)
      .relative()
      .cursor_pointer()
      .hover((el) => el.border_color(t.input))
      .when(this.pressed === addr && this.over && this.over !== addr, (el) => el.opacity(0.45))
      .when(Boolean(this.pressed) && this.over === addr && this.pressed !== addr, (el) =>
        el.child(div().absolute().left(8).right(8).h(3).rounded(2).bg(t.accent).when(dropBelow, (l) => l.bottom(-7)).when(!dropBelow, (l) => l.top(-7))),
      )
      .on_mouse_down("right", () => this.cardMenu(a, s))
      // Press and release on the same card: go to it. Release on another card: move it there.
      .on_mouse_down("left", () => {
        this.pressed = addr;
        this.over = addr;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed && this.over !== addr) {
          this.over = addr;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        this.over = null;
        if (from && from !== addr) this.move(from, addr, cx);
        else if (from === addr) {
          if (a?.pane) showPane(a.pane);
          else if (s?.terminal) run("agent.focus", { terminal: s.terminal });
        }
        cx.notify();
      })
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(this.dot(t, status))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(t.foreground).child(title))
          .when(needsYou, (el) =>
            el.child(div().flex_none().px(6).py(1).rounded(6).bg(t.blocked).text_color(t.background).text_size(10.5).font_medium().child("Needs you")),
          )
          .when(Boolean(sourceIcon), (el) => el.child(div().id(`${key}-src`).tooltip(s.source === "board" ? "From this session's todo board" : `Summarized by ${String(s.model ?? "a small model").split("/").pop()}. Change it: node todos.mjs config set model <provider/id>`).child(sourceIcon)))
          .when(Boolean(s?.summarized_at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(s.summarized_at)))),
      )
      .when(Boolean(tabLabel), (el) => el.child(div().mt(-4).pl(16).truncate().text_size(11).text_color(t.dim).child(tabLabel)))
      .when(Boolean(s?.now), (el) => el.child(div().pl(16).flex_none().line_height(`${LH.now}px`).text_size(12).text_color(t.muted).child(s.now)))
      .when(tasks.length > 0, (el) => el.child(v_flex().pl(2).pt(2).gap(5).children(tasks.map((task, i) => this.taskRow(t, task, i, key, addr, (task) => this.taskMenu(a, s, task))))))
      .when(hidden > 0, (el) => el.child(div().pl(23).text_size(11).text_color(t.dim).child(`+${hidden} more`)))
      .when(Boolean(placeholder), (el) =>
        el.child(
          h_flex()
            .pl(16)
            .gap(6)
            .items_center()
            .text_size(12)
            .text_color(t.dim)
            .when(!s && busy, (el) => el.child(svg(ICON("spinner")).size(11).text_color(t.dim).spin(1100)))
            .child(placeholder),
        ),
      )
      .when(Boolean(s?.error), (el) => el.child(div().pl(16).flex_none().line_height(`${LH.error}px`).text_size(11).text_color(t.dim).child(`Not updated: ${s.error}`)));
  }

  chip(t, color, n, label) {
    return h_flex()
      .gap(5)
      .items_center()
      .px(7)
      .h(20)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .child(div().w(6).h(6).rounded(3).bg(color))
      .child(div().text_size(11).text_color(t.foreground).font_medium().child(String(n)))
      .child(div().text_size(11).text_color(t.dim).child(label));
  }

  render(cx) {
    const t = theme();
    const sp = focused()?.space ?? this.shownSpace;
    const space = spaces().find((s) => s.id === sp);
    const doc = sp ? this.cache[sp] : null;
    const busy = sp ? this.busy.has(sp) : false;

    // A terminal keeps its last report after Pi exits, so once the helper has read the space its
    // list decides which are Pi sessions; agents it hasn't seen yet show while a read is running.
    const live = agents().filter((a) => a.space === sp && a.app === "pi");
    const bySession = new Map((doc?.sessions ?? []).map((s) => [s.terminal, s]));
    const rows = live
      .map((a) => ({ a, s: bySession.get(a.address) }))
      .filter(({ s }) => s || !doc || busy);
    // The person's order first (dragged cards), then the rest by urgency.
    const prefs = sp ? this.prefsFor(sp) : { order: [], priority: {} };
    const ranked = new Map(prefs.order.map((addr, i) => [addr, i]));
    const rankOf = (r) => (ranked.has(r.a.address) ? ranked.get(r.a.address) : Infinity);
    rows.sort((x, y) => rankOf(x) - rankOf(y) || (RANK[x.a.status] ?? 9) - (RANK[y.a.status] ?? 9) || x.a.tab_index - y.a.tab_index);
    for (const r of rows) {
      if (!r.s?.tasks) continue;
      r.s = { ...r.s, tasks: r.s.tasks.map((task) => ({ ...task, priority: prefs.priority[`${r.a.address}|${task.key}`] ?? "normal" })) };
    }
    this.shownOrder = rows.map((r) => r.a.address);
    const pressedAt = this.shownOrder.indexOf(this.pressed);

    const all = rows.flatMap((r) => r.s?.tasks ?? []);
    const count = (st) => all.filter((x) => x.status === st).length;
    const needsYou = rows.filter((r) => r.a.status === "blocked").length + count("blocked");
    const chips = [
      needsYou ? this.chip(t, t.blocked, needsYou, "needs you") : null,
      count("in_progress") ? this.chip(t, t.working, count("in_progress"), "doing") : null,
      count("todo") ? this.chip(t, t.dim, count("todo"), "next") : null,
      count("done") ? this.chip(t, t.done, count("done"), "done") : null,
    ].filter(Boolean);

    const error = sp ? this.errors[sp] : null;
    let empty = null;
    if (!sp) empty = "No space shown";
    else if (!rows.length) empty = busy && !doc ? "Reading sessions…" : "No Pi sessions in this space";

    const hasKeys = this.handle.is_focused();
    const summary = [needsYou ? `${needsYou} needs you` : null, count("in_progress") ? `${count("in_progress")} doing` : null, count("todo") ? `${count("todo")} next` : null].filter(Boolean).join(" · ") || `${rows.length} sessions`;
    if (!rows.some((r) => r.a.address === this.sel)) this.sel = rows[0]?.a.address ?? null;
    const parts = frameParts({ div, h_flex, v_flex }, t, this.frame, tip, () => this.viewState());
    const header = h_flex()
      .id("todos-header")
      .px(14)
      .h(36)
      .flex_none()
      .gap(8)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(this.frame.floating ? "Todos · drag to move the window" : `${tip(this.collapsed ? "Expand Todos" : "Collapse Todos", "−")} · drag onto another widget to move it`)
      .on_click(() => this.setCollapsed(!this.collapsed))
      // Pressing the bar starts a drag: release over another widget to land above or below it.
      .on_mouse_down("left", () => {
        if (!this.handle.is_focused()) this.takeKeyboardQuietly();
        this.frame.dragStart();
      })
      .child(div().flex_none().text_size(10).text_color(t.dim).child(this.collapsed ? "▸" : "▾"))
      .child(div().flex_none().text_size(11.5).font_medium().text_color(hasKeys ? t.accent : t.dim).child("Todos"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.collapsed ? `· ${summary}` : space?.name ?? ""))
      .child(
        div()
          .id("todos-refresh")
          .flex_none()
          .p(3)
          .rounded(5)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(busy ? "Updating…" : tip("Update now", "R"))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            sp && this.refresh(sp, cx, true);
          })
          .child(busy ? svg(ICON("spinner")).size(13).spin(900) : svg(ICON("refresh")).size(13)),
      )
      .children(parts.buttons);

    const footerText = this.notice ? this.notice : busy ? "Updating…" : doc?.updated_at ? `Updated ${ago(doc.updated_at) === "now" ? "just now" : `${ago(doc.updated_at)} ago`}` : "";

    const shell = v_flex()
      .id("root")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.command(e.keystroke, cx)) cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_l(1)
      .border_color(t.border)
      .when(hasKeys, (el) => el.border_t(2).border_color(t.accent))
      .text_size(13)
      .relative()
      .on_mouse_up("left", () => this.frame.dragCancel())
      .child(header)
      .when(Boolean(parts.note), (el) => el.child(parts.note))
      .when(Boolean(parts.drop), (el) => el.child(parts.drop));
    if (this.collapsed) return shell;
    const showTab = new Set(rows.map((r) => r.a.tab)).size > 1;
    this.widths = textWidths(this.viewW ?? (this.frame.floating ? 360 : 304));
    const heights = rows.map(({ a, s }) => this.shape(a, s, busy, showTab).height + 8);
    return shell
      .when(chips.length > 0 && !empty, (el) => el.child(h_flex().px(12).pb(8).pt(2).gap(6).flex_wrap().flex_none().children(chips)))
      .when(Boolean(empty), (el) =>
        el.child(
          v_flex()
            .px(16)
            .pt(16)
            .gap(6)
            .child(div().text_size(12.5).text_color(t.muted).child(empty))
            .when(!busy && Boolean(sp) && !rows.length, (el) =>
              el.child(div().text_size(12).text_color(t.dim).child("Start Pi in a tab here. Its tasks show up after the first reply.")),
            ),
        ),
      )
      .when(!empty, (el) =>
        el.child(
          windowedList(this, t, "todos-list", heights, (i) => div().px(10).pb(8).child(this.card(t, rows[i].a, rows[i].s, busy, showTab, pressedAt >= 0 && pressedAt < i)), 150, NAME).on_mouse_up("left", (_e, cx) => {
            this.pressed = null;
            this.over = null;
            cx.notify();
          }),
        ),
      )
      .when(Boolean(empty), (el) => el.child(div().flex_1()))
      .child(legend(t, [["↑↓", "Select"], ["Enter", "Go to session"], ["Tab", "Next"], ["−", "Collapse"], ...parts.legend, ["Esc", "Back"]]))
      .child(
        v_flex()
          .flex_none()
          .px(14)
          .py(7)
          .gap(2)
          .border_t(1)
          .border_color(t.border)
          .when(Boolean(error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`Update failed: ${error}`)))
          .when(!error && Boolean(doc?.settings_problems?.length), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`Settings: ${(doc?.settings_problems ?? []).join(" · ")}`)))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .text_size(11)
              .text_color(t.dim)
              .child(div().flex_1().truncate().child(footerText))
              .child(
                div()
                  .id("todos-model")
                  .flex_none()
                  .px(4)
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip(`Task lists by ${doc?.model ?? "the model in the settings"}. Click to choose another`)
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.modelMenu(cx);
                  })
                  .child(doc?.model ? String(doc.model).split("/").pop().replace(/^claude-/, "") : "model"),
              ),
          ),
      );
  }
}
