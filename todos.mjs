#!/usr/bin/env node
// Todos for a Herdr space: finds the Pi sessions running in that space, reads their journals and
// keeps a short task list per session. Task boards written by Pi's `todo` tool are read as-is;
// other sessions are summarized by a small model when their journal changes.
//
//   node todos.mjs refresh --space <id> [--state <dir>] [--model <provider/id>] [--force]
//   node todos.mjs show    --space <id> [--state <dir>]
//   node todos.mjs config | config set <key> <value> [--project] | config path
//   node todos.mjs describe
//
// stdout is one JSON document. Errors print JSON to stderr and exit 1.

const WIDGET = "todos";
const VERSION = 1;
// The settings: one schema for the settings files, `config set`, `describe` and the environment.
const SETTINGS = {
  model: { type: "model", default: "anthropic/claude-haiku-5-5", meaning: "The small model that writes each task list (provider/id from `pi --list-models`)." },
  thinking: { type: "enum", values: ["off", "low", "medium", "high"], default: "off", meaning: "Thinking level passed to the model." },
  refreshSeconds: { type: "integer", min: 15, max: 3600, default: 120, meaning: "A session that is still working gets its list rewritten at most this often." },
  maxTasksShown: { type: "integer", min: 1, max: 20, default: 8, meaning: "The most tasks kept per session from the model's list." },
  modelCmd: { type: "argv", default: null, meaning: 'A command run instead of Pi for every model call, as a JSON array; it gets {"model","system","input","thinking"} as JSON on stdin and prints the reply.' },
};
const LEGACY_KEYS = { model_cmd: "modelCmd" }; // earlier names in the settings file
const LEGACY_ENV = {}; // HERDR_TODOS_MODEL and HERDR_TODOS_MODEL_CMD keep their names

// >>> shared block: the same, byte for byte, in herdr-todos/todos.mjs and herdr-memories/memories.mjs
// (test/shared.test.mjs compares them). It is in this file, not a module beside it, because for a
// space on another machine the whole helper is piped to that machine's Node as one file.
// It uses the constants above it: WIDGET, VERSION, SETTINGS, LEGACY_KEYS, LEGACY_ENV.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const RECENT_FILE_DAYS = 21;
const MAX_FILES_PER_DIR = 80;
const TAIL_BYTES = 768 * 1024;
const CONVERSATION_BUDGET = 14_000;
const MAX_PARALLEL = 4;

// ---------- args ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const stateDir = path.resolve(expandHome(typeof args.state === "string" ? args.state : `~/.cache/herdr-${WIDGET}`));
const piAgentDir = expandHome(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ error: code, message, ...extra }) + "\n");
  process.exit(1);
}

const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");

// ---------- settings ----------
// defaults < user file (~/.config/herdr-<widget>/config.json) < project file
// (<project>/.herdr/<widget>.json) < environment (HERDR_<WIDGET>_<KEY>). The file is the main way:
// the Herdr app starts this helper, and an app opened from the Dock has no shell environment.
// SETTINGS (above) is the one schema: the file reader, `config set` and `describe` all use it.

const ENV_PREFIX = `HERDR_${WIDGET.toUpperCase()}_`;
const envName = (key) => ENV_PREFIX + key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
const userSettingsFile = () => path.resolve(expandHome(process.env[`${ENV_PREFIX}CONFIG`] || `~/.config/herdr-${WIDGET}/config.json`));
const projectSettingsFile = (root) => path.join(root, ".herdr", `${WIDGET}.json`);

// The cleaned value, or an Error that says what is allowed.
function checkSetting(key, value) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`unknown key "${key}" (the keys are: ${Object.keys(SETTINGS).join(", ")})`);
  if (spec.type === "integer") {
    const n = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw new Error(`${key} must be a whole number from ${spec.min} to ${spec.max}`);
    return n;
  }
  if (spec.type === "argv") {
    let v = value;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        v = null;
      }
    }
    if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x)) throw new Error(`${key} must be a JSON array of strings, like ["node","model.mjs"]`);
    return v;
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be text`);
  const s = value.trim();
  if (spec.type === "enum" && !spec.values.includes(s)) throw new Error(`${key} must be one of: ${spec.values.join(", ")}`);
  if (spec.type === "model" && !/^[^/\s]+\/\S+$/.test(s)) throw new Error(`${key} must be provider/id, like ${SETTINGS.model.default} (list them with: pi --list-models)`);
  if (spec.type === "filename" && (/[/\\]/.test(s) || s.startsWith("."))) throw new Error(`${key} must be a file name in the project folder, like ${spec.default}`);
  return s;
}

// A missing file is no settings. A broken file, an unknown key or a bad value is a named problem;
// the other values still count and the defaults fill the rest.
function readSettingsFile(file, problems) {
  let raw;
  try {
    raw = fsSync.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let doc;
  try {
    doc = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("it must be a JSON object");
  } catch (e) {
    problems.push({ error: "INVALID_CONFIG", file, message: `${file} can't be read (${e.message}); the defaults are used` });
    return {};
  }
  const out = {};
  for (const [name, value] of Object.entries(doc)) {
    const key = LEGACY_KEYS[name] ?? name;
    try {
      out[key] = checkSetting(key, value);
    } catch (e) {
      problems.push({ error: SETTINGS[key] ? "INVALID_VALUE" : "UNKNOWN_KEY", file, key: name, message: `${file}: ${e.message}` });
    }
  }
  return out;
}

const settingsCache = new Map();
// The settings in force for a project folder (or for no project): { values, sources, files, problems }.
function settingsFor(root = null) {
  const id = root ?? "";
  if (settingsCache.has(id)) return settingsCache.get(id);
  const problems = [];
  const values = {};
  const sources = {};
  for (const [key, spec] of Object.entries(SETTINGS)) {
    values[key] = spec.default;
    sources[key] = "default";
  }
  const layer = (found, source) => {
    for (const [key, value] of Object.entries(found)) {
      values[key] = value;
      sources[key] = source;
    }
  };
  const files = { user: userSettingsFile(), project: root ? projectSettingsFile(root) : null };
  layer(readSettingsFile(files.user, problems), "user file");
  if (files.project) layer(readSettingsFile(files.project, problems), "project file");
  for (const key of Object.keys(SETTINGS)) {
    // An older variable name first, so the current name wins when both are set.
    for (const name of [...(LEGACY_ENV[key] ?? []), envName(key)]) {
      const raw = process.env[name];
      if (raw == null || raw === "") continue;
      try {
        values[key] = checkSetting(key, raw);
        sources[key] = `environment (${name})`;
      } catch (e) {
        problems.push({ error: "INVALID_VALUE", key, message: `${name}: ${e.message}` });
      }
    }
  }
  if (typeof args.model === "string") {
    try {
      values.model = checkSetting("model", args.model);
      sources.model = "--model";
    } catch (e) {
      problems.push({ error: "INVALID_VALUE", key: "model", message: `--model: ${e.message}` });
    }
  }
  const found = { values, sources, files, problems };
  settingsCache.set(id, found);
  return found;
}

const describeSettings = () => Object.fromEntries(Object.entries(SETTINGS).map(([key, spec]) => [key, { ...spec, environment: [envName(key), ...(LEGACY_ENV[key] ?? [])] }]));

// config | config path | config set <key> <value> [--project [folder]] | config unset <key> [--project [folder]]
async function configCommand() {
  const sub = args._[1];
  const named = typeof args.project === "string" ? path.resolve(expandHome(args.project)) : null;
  const project = named ?? (await gitRoot(process.cwd(), {})) ?? (args.project ? process.cwd() : null);
  if (sub === "path") return print({ user: userSettingsFile(), project: project ? projectSettingsFile(project) : null });
  let changed = null;
  if (sub === "set" || sub === "unset") {
    const key = args._[2];
    if (!key) fail("INVALID", `config ${sub} <key>${sub === "set" ? " <value>" : ""} [--project]; the keys are: ${Object.keys(SETTINGS).join(", ")}`);
    if (!SETTINGS[key]) fail("UNKNOWN_KEY", `unknown key "${key}" (the keys are: ${Object.keys(SETTINGS).join(", ")})`);
    let value;
    if (sub === "set") {
      if (args._.length < 4) fail("INVALID", `config set ${key} <value> [--project]`);
      try {
        value = checkSetting(key, args._.slice(3).join(" "));
      } catch (e) {
        fail("INVALID_VALUE", e.message);
      }
    }
    if (args.project && !project) fail("INVALID", "--project needs a project folder");
    const file = args.project ? projectSettingsFile(project) : userSettingsFile();
    let doc = {};
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (raw != null) {
      try {
        doc = JSON.parse(raw);
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("it must be a JSON object");
      } catch (e) {
        fail("INVALID_CONFIG", `${file} can't be read (${e.message}); fix or delete it, then set the value again`);
      }
    }
    for (const [old, now] of Object.entries(LEGACY_KEYS)) if (now === key) delete doc[old];
    if (sub === "set") doc[key] = value;
    else delete doc[key];
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(doc, null, 2) + "\n");
    settingsCache.clear();
    changed = { file, key, ...(sub === "set" ? { value } : { removed: true }) };
  } else if (sub !== undefined) fail("INVALID", "config | config path | config set <key> <value> [--project] | config unset <key> [--project]");
  const s = settingsFor(project);
  print({
    widget: WIDGET,
    ...(changed ? { changed } : {}),
    settings: Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, { value: s.values[key], from: s.sources[key] }])),
    files: s.files,
    problems: s.problems,
  });
}

// ---------- small io helpers ----------

function run(cmd, argv, { input, timeout = 30_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[timeout after ${timeout}ms]`;
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Every model call goes through here. Default: Pi in print mode with no tools, extensions or
// context files. The modelCmd setting (an argv array) replaces Pi with another command: it gets
// {"model", "system", "input", "thinking"} as JSON on stdin and prints the model's reply on stdout.
// A failure names the model and how to change it.
async function callModel({ model, system, input, settings, timeout = 90_000 }) {
  const { thinking, modelCmd } = settings.values;
  const r = modelCmd
    ? await run(modelCmd[0], modelCmd.slice(1), { input: JSON.stringify({ model, system, input, thinking }), timeout })
    : await run(
        "pi",
        ["-p", "--no-session", "-ne", "-nt", "-ns", "-np", "-nc", "--no-mcp", "--no-themes", "--thinking", thinking, "--model", model, "--system-prompt", system],
        { input, timeout, env: { ...process.env, PI_NO_TITLE: "1" } },
      );
  if (r.code !== 0) {
    const why = (r.stderr.trim().split("\n").pop() || `exit ${r.code}`).slice(0, 160);
    throw new Error(`${modelCmd ? `${modelCmd[0]} (modelCmd)` : model} failed: ${why}. Another model: node ${WIDGET}.mjs config set model <provider/id>`);
  }
  return r.stdout;
}

async function hcJson(argv) {
  const r = await run("hc", [...argv, "--json"], { timeout: 15_000 });
  if (r.code !== 0) throw new Error(`hc ${argv.join(" ")} failed: ${r.stderr.trim() || r.code}`);
  return JSON.parse(r.stdout);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 1));
  await fs.rename(tmp, file);
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const indexFile = () => path.join(stateDir, "index.json");
const readIndex = () => readJson(indexFile(), { version: VERSION, files: {} });
// Merges with the index another run may have written meanwhile.
async function saveIndex(index) {
  const latest = await readIndex();
  for (const [f, v] of Object.entries(index.files)) if (!latest.files[f] || latest.files[f].offset <= v.offset) latest.files[f] = v;
  latest.roots = { ...(latest.roots ?? {}), ...(index.roots ?? {}) };
  await writeJsonAtomic(indexFile(), latest);
}

async function gitRoot(cwd, cache) {
  if (cache[cwd] !== undefined) return cache[cwd];
  const r = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 });
  cache[cwd] = r.code === 0 ? r.stdout.trim() || null : null;
  return cache[cwd];
}

async function withLock(space, fn) {
  const lock = path.join(stateDir, "locks", `${space.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  try {
    const fh = await fs.open(lock, "wx");
    await fh.write(String(process.pid));
    await fh.close();
  } catch {
    const pid = Number(await fs.readFile(lock, "utf8").catch(() => "0"));
    const st = await fs.stat(lock).catch(() => null);
    let alive = false;
    try {
      if (pid) process.kill(pid, 0), (alive = true);
    } catch {}
    if (alive && st && Date.now() - st.mtimeMs < 5 * 60_000) return null;
    await fs.rm(lock, { force: true });
    return withLock(space, fn);
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

// ---------- Pi session journals ----------

// Pi keeps a folder per working directory: /Users/me/dev/app -> --Users-me-dev-app--
function sessionDirFor(cwd) {
  const slug = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(piAgentDir, "sessions", slug);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

// Reads only what was appended since the last scan: session names, the first request and the
// latest task-board snapshot. Journals are append-only; a shrunk file is rescanned.
// Picks what we keep from one journal line: session names, the first request, the latest board.
function scanLine(entry, line) {
  if (!line) return;
  if (line.includes('"session_info"')) {
    try {
      const e = JSON.parse(line);
      if (e.type === "session_info") entry.name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : null;
    } catch {}
  } else if (line.includes('"herdr-pi-todos/v1"')) {
    try {
      const e = JSON.parse(line);
      if (e.type === "custom" && e.customType === "herdr-pi-todos/v1" && Array.isArray(e.data?.tasks)) {
        entry.board = e.data.tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status, activeForm: t.activeForm || null, priority: t.priority }));
        entry.boardAt = e.timestamp || null;
      }
    } catch {}
  } else if (!entry.first && line.includes('"role":"user"')) {
    try {
      const e = JSON.parse(line);
      if (e.type === "message" && e.message?.role === "user") entry.first = textOf(e.message.content).slice(0, 1500) || null;
    } catch {}
  }
}

async function scanFile(file, stat, prev) {
  let entry = prev && prev.size <= stat.size && prev.ino === stat.ino ? { ...prev } : { offset: 0, name: null, first: null, board: null, boardAt: null };
  entry.size = stat.size;
  entry.mtime = stat.mtimeMs;
  entry.ino = stat.ino;
  if (entry.offset >= stat.size) return entry;
  // Read in chunks: journals can be hundreds of megabytes.
  const CHUNK = 8 * 1024 * 1024;
  const fh = await fs.open(file, "r");
  try {
    let carry = Buffer.alloc(0);
    let pos = entry.offset;
    while (pos < stat.size) {
      const length = Math.min(CHUNK, stat.size - pos);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, pos);
      pos += length;
      const data = carry.length ? Buffer.concat([carry, buf]) : buf;
      const lastNl = data.lastIndexOf(10);
      if (lastNl < 0) {
        // One line longer than a chunk (a huge tool result): skip it, it holds nothing we read.
        if (data.length > 64 * 1024 * 1024) {
          carry = Buffer.alloc(0);
          entry.offset = pos;
        } else carry = data;
        continue;
      }
      for (const line of data.subarray(0, lastNl).toString("utf8").split("\n")) scanLine(entry, line);
      entry.offset = pos - (data.length - lastNl - 1);
      carry = data.subarray(lastNl + 1);
    }
  } finally {
    await fh.close();
  }
  return entry;
}

async function listSessionFiles(dir, index) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - RECENT_FILE_DAYS * 86400_000;
  const stats = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const file = path.join(dir, n);
    try {
      const st = await fs.stat(file);
      if (st.mtimeMs >= cutoff) stats.push({ file, st });
    } catch {}
  }
  stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = [];
  for (const { file, st } of stats.slice(0, MAX_FILES_PER_DIR)) {
    index.files[file] = await scanFile(file, st, index.files[file]);
    out.push({ file, ...index.files[file] });
  }
  return out;
}

// Pi's session folders touched recently, newest first.
async function recentSessionDirs() {
  const root = path.join(piAgentDir, "sessions");
  const cutoff = Date.now() - RECENT_FILE_DAYS * 86400_000;
  const names = await fs.readdir(root).catch(() => []);
  const dirs = [];
  for (const n of names) {
    const st = await fs.stat(path.join(root, n)).catch(() => null);
    if (st?.isDirectory() && st.mtimeMs >= cutoff) dirs.push({ dir: path.join(root, n), at: st.mtimeMs });
  }
  return dirs.sort((a, b) => b.at - a.at).map((d) => d.dir);
}

// The active branch's recent conversation: the newest entry, then its parents.
async function recentConversation(file) {
  const st = await fs.stat(file);
  const start = Math.max(0, st.size - TAIL_BYTES);
  const fh = await fs.open(file, "r");
  let text;
  try {
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    await fh.close();
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  const byId = new Map();
  let leaf = null;
  for (const line of lines) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.id) continue;
    byId.set(e.id, e);
    if (e.type === "message") leaf = e;
  }
  const out = [];
  let used = 0;
  let pendingTools = [];
  for (let e = leaf; e && used < CONVERSATION_BUDGET; e = e.parentId ? byId.get(e.parentId) : null) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user") {
      const t = textOf(m.content).trim();
      if (!t) continue;
      const s = t.length > 1800 ? t.slice(0, 1800) + " …" : t;
      out.push({ id: e.id, role: "user", at: e.timestamp, text: s });
      used += s.length;
    } else if (m.role === "assistant") {
      const t = textOf(m.content).trim();
      const tools = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "toolCall").map((p) => p.name) : [];
      if (t) {
        const s = t.length > 1400 ? t.slice(0, 700) + " … " + t.slice(-600) : t;
        out.push({ id: e.id, role: "assistant", at: e.timestamp, text: s, tools: [...new Set([...tools, ...pendingTools])].slice(0, 8) });
        used += s.length;
        pendingTools = [];
      } else if (tools.length) {
        pendingTools.push(...tools);
      }
    }
  }
  return out.reverse();
}

// ---------- terminal -> session ----------

const REST = new Set(["done", "idle"]);

async function piTerminalsIn(space) {
  const raw = await hcJson(["ls"]);
  const ls = Array.isArray(raw) ? raw : raw.terminals ?? [];
  const pis = ls.filter((t) => t.state === "live" && t.agent === "pi");
  const details = await pool(pis, 8, async (t) => {
    try {
      return await hcJson(["get", t.address]);
    } catch {
      return null;
    }
  });
  return details.filter((d) => {
    if (!d || d.labels?.["herdr.space"] !== space || d.parent) return false;
    const argv0 = path.basename(d.foreground?.argv?.[0] ?? "");
    return /^pit?$/.test(argv0) || d.status?.app === "pi";
  });
}

function statusWord(t) {
  const s = t.status?.state ?? t.status;
  return typeof s === "string" ? s : "idle";
}

async function mapTerminals(terms, index, previous) {
  const claimed = new Set();
  const result = new Map();
  const prevBy = new Map((previous?.sessions ?? []).map((s) => [s.terminal, s]));
  const dirs = new Map();
  const filesFor = async (cwd) => {
    const dir = sessionDirFor(cwd);
    if (!dirs.has(dir)) dirs.set(dir, await listSessionFiles(dir, index));
    return dirs.get(dir);
  };
  const exists = async (f) => !!(await fs.stat(f).catch(() => null));

  // 1. An explicit label wins: pi.session=<file>.
  for (const t of terms) {
    const f = t.labels?.["pi.session"];
    if (f && (await exists(f))) {
      result.set(t.address, { file: f, mapping: "label" });
      claimed.add(f);
      await filesFor(t.foreground?.cwd || t.cwd);
    }
  }
  // 2. Pi reports its session name while working or done; match it to the journal's name.
  for (const t of terms) {
    if (result.has(t.address)) continue;
    const cwd = t.foreground?.cwd || t.cwd;
    const files = await filesFor(cwd);
    // Pi reports its session name while working or done, and titles its terminal
    // "π - <session name> - <folder>" (the only clue while idle).
    const title = (t.title ?? "").replace(/^π\s+-\s+/, "");
    const fromTitle = title !== (t.title ?? "") && title.includes(" - ") ? title.slice(0, title.lastIndexOf(" - ")).trim() : null;
    const name = (["working", "done"].includes(statusWord(t)) ? t.status?.msg?.trim() : null) || fromTitle || null;
    if (!name) continue;
    const prev = prevBy.get(t.address);
    let matches = files.filter((f) => f.name === name && !claimed.has(f.file));
    // A session started elsewhere keeps its first folder's journal (a moved or renamed folder,
    // or a `cd` before starting): look through Pi's other recent folders for the name.
    if (!matches.length) {
      for (const dir of await recentSessionDirs()) {
        if (dirs.has(dir)) continue;
        dirs.set(dir, await listSessionFiles(dir, index));
        matches = dirs.get(dir).filter((f) => f.name === name && !claimed.has(f.file));
        if (matches.length) break;
      }
    }
    if (!matches.length) continue;
    const keep = prev && prev.pid === t.foreground?.pid && matches.find((m) => m.file === prev.file);
    const pick = keep ?? matches[0];
    result.set(t.address, { file: pick.file, mapping: matches.length === 1 || keep ? "name" : "name-newest" });
    claimed.add(pick.file);
  }
  // 3. The same Pi process as last time keeps its journal.
  for (const t of terms) {
    if (result.has(t.address)) continue;
    const prev = prevBy.get(t.address);
    if (prev?.file && prev.pid === t.foreground?.pid && !claimed.has(prev.file) && (await exists(prev.file))) {
      result.set(t.address, { file: prev.file, mapping: "cached" });
      claimed.add(prev.file);
    }
  }
  // 4. Otherwise the newest unclaimed journal in its folder, if it changed since the process started.
  for (const t of terms) {
    if (result.has(t.address)) continue;
    const files = await filesFor(t.foreground?.cwd || t.cwd);
    const startedMs = t.created_ms ?? 0;
    const pick = files.find((f) => !claimed.has(f.file) && f.mtime >= startedMs - 60_000);
    if (pick) {
      result.set(t.address, { file: pick.file, mapping: "newest" });
      claimed.add(pick.file);
    } else result.set(t.address, { file: null, mapping: "none" });
  }
  return result;
}

// ---------- a new Pi beside a session ----------

// Messages the widgets and the harness put into a conversation: never the person's own words.
const INJECTED = [
  /^The conversation history above was just compacted/,
  /^Provider retry activated/,
  /^Inspect subagent updates above/,
  /^Continue the original task from its last verified state/,
  /^\[From the (?:Todos|Memories) sidebar\]/,
  /^(?:Provider|Model) (?:retry|fallback|switch)/,
  /^\s*</,
  /^\[(?:subagent|hub|system|automated)/i,
];

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (fsSync.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

// This file's path when run from disk; null when piped to another machine's Node.
function selfPath() {
  try {
    const u = new URL(import.meta.url);
    return u.protocol === "file:" ? decodeURIComponent(u.pathname) : null;
  } catch {
    return null;
  }
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function launchArgv({ folder, fork, name, prompt }) {
  const pi = findOnPath("pi");
  if (!pi) fail("NO_PI", "pi is not on PATH here");
  const piArgv = [pi, ...(fork ? ["--fork", fork] : []), "--name", name, prompt];
  // pane.split takes argv, not a folder: cd there first, paths passed as data, never as shell source.
  return ["/bin/sh", "-c", 'cd "$1" && shift && exec "$@"', `${WIDGET}-explain`, folder, "/usr/bin/env", `PATH=${process.env.PATH ?? ""}`, ...piArgv];
}

const short = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
// <<< shared block

const spaceFile = (space) => path.join(stateDir, "spaces", `${space.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const prefsFile = (space) => path.join(stateDir, "prefs", `${space.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const LEVELS = ["high", "normal", "low"];

// The models Pi knows, for the sidebar's model picker: { current, models: ["provider/id", ...] }.
// With modelCmd set, it is asked first with {"list": true} (it knows how to start Pi here, e.g.
// which Node); a reply that is not a `pi --list-models` table falls back to `pi --list-models`.
function parseModelTable(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => /^provider\s+model\b/.test(l));
  if (at < 0) return [];
  return lines
    .slice(at + 1)
    .map((l) => l.split(/\s+/))
    .filter(([provider, id]) => provider && id)
    .map(([provider, id]) => `${provider}/${id}`);
}
async function listModels() {
  const settings = settingsFor(null);
  const { modelCmd, model: current } = settings.values;
  let why = null;
  if (modelCmd) {
    const r = await run(modelCmd[0], modelCmd.slice(1), { input: JSON.stringify({ list: true }), timeout: 30_000 });
    const models = r.code === 0 ? parseModelTable(r.stdout) : [];
    if (models.length) return { current, models };
    why = `${modelCmd[0]} (modelCmd) gave no model list`;
  }
  const r = await run("pi", ["--list-models"], { timeout: 30_000 });
  const models = r.code === 0 ? parseModelTable(r.stdout) : [];
  if (models.length) return { current, models };
  const last = (r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 160);
  fail("FAILED", `${why ? `${why}; ` : ""}pi --list-models failed: ${last || `exit ${r.code}`}`);
}

// The person's choices for a space: session order (terminal addresses, first = most important)
// and task priorities keyed "<terminal>|<task key>".
async function readPrefs(space) {
  const p = await readJson(prefsFile(space), {});
  return { order: Array.isArray(p.order) ? p.order.filter((x) => typeof x === "string") : [], priority: p.priority && typeof p.priority === "object" ? p.priority : {} };
}

// Stable identity for a task: a board task's id, else its words.
const taskKey = (t) => (t.id != null ? `#${t.id}` : t.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim());

function applyPrefs(doc, prefs) {
  const rank = new Map(prefs.order.map((a, i) => [a, i]));
  for (const s of doc.sessions) {
    s.tasks = (s.tasks ?? []).map((t) => {
      const key = taskKey(t);
      const level = prefs.priority[`${s.terminal}|${key}`];
      return { ...t, key, priority: LEVELS.includes(level) ? level : "normal" };
    });
    s.rank = rank.has(s.terminal) ? rank.get(s.terminal) : null;
  }
  doc.prefs = prefs;
  return doc;
}

// ---------- summaries ----------

const SYSTEM = `You keep a glanceable task list for one coding-agent session that a person checks between other work.
Return JSON only, no markdown:
{"title": string, "now": string, "tasks": [{"text": string, "status": "in_progress" | "todo" | "done" | "blocked"}]}
- title: 2-5 words naming what this session is about.
- now: at most 80 characters. While working: what the agent is doing. Otherwise: the outcome, or what the person should do next. Plain words; never "Session complete" or "Done.".
- tasks: 1-6 items the person asked for or the agent committed to. Outcomes, not individual tool calls. At most 60 characters each, starting with a verb.
- Reuse the wording of previous tasks that still apply and update their status, so the list stays stable between updates. A previous task with a "priority" was ranked by the person: keep its text exactly, character for character, and keep it in the list until it is done.
- "done" only when the conversation shows the work finished. "blocked" when it waits on the person: a question, an approval, a decision, a missing login. "in_progress" for what is being worked on now. "todo" for agreed work not started.
- Keep at most 3 done tasks: the most recent ones. Order: blocked, in_progress, todo, done.
- If the agent's status is "working", the newest request is not finished yet.`;

function parseModelJson(text, maxTasks) {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("model reply had no JSON object");
  const v = JSON.parse(cleaned.slice(a, b + 1));
  const STATUSES = ["in_progress", "todo", "done", "blocked"];
  const tasks = Array.isArray(v.tasks) ? v.tasks : [];
  return {
    title: String(v.title ?? "").slice(0, 60).trim() || null,
    now: String(v.now ?? "").slice(0, 120).trim() || null,
    tasks: tasks
      .filter((t) => t && typeof t.text === "string" && t.text.trim())
      .slice(0, maxTasks)
      .map((t) => ({ text: t.text.trim().slice(0, 90), status: STATUSES.includes(t.status) ? t.status : "todo" })),
  };
}

async function summarize({ status, name, cwd, first, conversation, previous, settings }) {
  const payload = {
    agent_status: status,
    session_name: name,
    folder: cwd,
    first_request: first,
    previous: previous ? { title: previous.title, now: previous.now, tasks: (previous.tasks ?? []).map((t) => ({ text: t.text, status: t.status, ...(t.priority && t.priority !== "normal" ? { priority: t.priority } : {}) })) } : null,
    conversation,
  };
  const prompt = `Session data:\n${JSON.stringify(payload)}\n\nReturn the JSON task list now.`;
  return parseModelJson(await callModel({ model: settings.values.model, system: SYSTEM, input: prompt, settings }), settings.values.maxTasksShown);
}

function boardTasks(board) {
  const MAP = { pending: "todo", in_progress: "in_progress", completed: "done" };
  const live = board.filter((t) => MAP[t.status]);
  const open = live.filter((t) => t.status !== "completed");
  const done = live.filter((t) => t.status === "completed").slice(-3);
  const order = { in_progress: 0, todo: 1, done: 2 };
  return [...open, ...done]
    .map((t) => ({ id: t.id, text: t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject, status: MAP[t.status] }))
    .sort((a, b) => order[a.status] - order[b.status]);
}

// ---------- commands ----------

async function refresh(space, force) {
  const previous = await readJson(spaceFile(space), null);
  const result = await withLock(space, async () => {
    const index = await readIndex();
    index.roots = index.roots ?? {};
    const terms = await piTerminalsIn(space);
    const mapping = await mapTerminals(terms, index, previous);
    const prevBy = new Map((previous?.sessions ?? []).map((s) => [s.terminal, s]));
    const now = Date.now();

    const sessions = await pool(terms, MAX_PARALLEL, async (t) => {
      const { file, mapping: how } = mapping.get(t.address);
      const status = statusWord(t);
      const cwd = t.foreground?.cwd || t.cwd;
      const prev = prevBy.get(t.address);
      // The project (git root) decides which project settings file counts for this session.
      const root = cwd ? await gitRoot(cwd, index.roots) : null;
      const settings = settingsFor(root);
      const base = {
        terminal: t.address,
        tab: t.labels?.["herdr.tab"] ?? null,
        pid: t.foreground?.pid ?? null,
        cwd,
        root,
        model: settings.values.model,
        status,
        name: null,
        file,
        mapping: how,
        title: null,
        now: null,
        tasks: [],
        source: "none",
        summarized_at: null,
        fingerprint: null,
        error: null,
      };
      if (!file) return { ...base, now: "Waiting for this session's first message" };
      const info = index.files[file] ?? (await scanFile(file, await fs.stat(file), null));
      index.files[file] = info;
      base.name = info.name;
      const fingerprint = `${info.size}`;
      const same = prev && prev.file === file;

      if (info.board && info.board.length) {
        const at = Date.parse(info.boardAt ?? "") || now;
        return { ...base, title: info.name, tasks: boardTasks(info.board), source: "board", summarized_at: at, fingerprint };
      }
      const fresh = same && prev.fingerprint === fingerprint && prev.status === status && prev.source === "haiku" && !prev.error;
      const throttled = same && status === "working" && prev.status === "working" && prev.summarized_at && now - prev.summarized_at < settings.values.refreshSeconds * 1000;
      if (!force && (fresh || throttled) && prev.model === base.model) return { ...prev, status, mapping: how, name: info.name, pid: base.pid, tab: base.tab, root };

      try {
        const conversation = await recentConversation(file);
        if (!conversation.length) return { ...base, title: info.name, now: "No conversation yet", fingerprint };
        const s = await summarize({ status, name: info.name, cwd, first: info.first, conversation, previous: same ? prev : null, settings });
        return { ...base, ...s, title: s.title || info.name, source: "haiku", summarized_at: now, fingerprint };
      } catch (e) {
        // Keep the last good list, say why it is stale.
        if (same && prev.tasks?.length) return { ...prev, status, mapping: how, error: String(e.message || e).slice(0, 400) };
        return { ...base, title: info.name, error: String(e.message || e).slice(0, 400) };
      }
    });

    await saveIndex(index);

    const user = settingsFor(null);
    const doc = applyPrefs(
      { version: VERSION, space, model: user.values.model, settings_problems: [...new Set([user, ...sessions.map((s) => settingsFor(s.root))].flatMap((s) => s.problems.map((p) => p.message)))], updated_at: now, state: sessions.length ? "ready" : "empty", sessions },
      await readPrefs(space),
    );
    await writeJsonAtomic(spaceFile(space), doc);
    return doc;
  });
  if (result) return result;
  return { ...(previous ?? { version: VERSION, space, sessions: [], updated_at: null, state: "empty" }), busy: true };
}

// ---------- explain in a split ----------
// A right-click on a task or a session opens a new Pi beside the session it came from, on a fork
// of that conversation (`pi --fork`: a copy; the original keeps going on its own), with a first
// message asking it to explain. The person can then ask it to act; the prompt names the commands
// that change the sidebar. This prints the command; the sidebar (or an agent) opens the pane with
// `herdr-app do pane.split {pane, direction: "right", argv}`.

const SPLIT_TAG = "[From the Todos sidebar]";

async function explainTask(space, terminal, taskKey) {
  const doc = await readJson(spaceFile(space), null);
  const s = doc?.sessions?.find((x) => x.terminal === terminal);
  if (!s) fail("NOT_FOUND", `no session ${terminal} in space ${space}; refresh first`);
  const prefs = await readPrefs(space);
  const task = taskKey ? (s.tasks ?? []).find((t) => (t.key ?? taskKey) === taskKey || taskKey === `#${t.id}`) : null;
  if (taskKey && !task) fail("NOT_FOUND", `no task ${taskKey} on ${terminal}`);
  const helperPath = selfPath();
  const level = task ? prefs.priority[`${terminal}|${task.key}`] ?? "normal" : null;
  const lines = [SPLIT_TAG];
  lines.push("This is a split of the conversation above: a copy. The original session keeps going on its own, so don't repeat or undo its work.");
  if (task) {
    lines.push("", `The sidebar lists this task for it: "${task.text}" (status: ${task.status.replace("_", " ")}${level !== "normal" ? `, priority: ${level}` : ""}).`);
    lines.push("", "Explain it from the conversation, briefly: what it is and why it came up, where it stands now, and what is left or what it is waiting on. Then wait for me.");
  } else {
    lines.push("", `The sidebar shows this session as "${s.title ?? s.name ?? "Pi session"}"${s.now ? `, now: "${s.now}"` : ""}, with these tasks:`);
    for (const t of s.tasks ?? []) lines.push(`- ${t.text} (${t.status.replace("_", " ")})`);
    lines.push("", "Explain briefly where this session stands: what was asked, what is done, what is left, and anything it needs from me. Then wait for me.");
  }
  lines.push("", "If I ask, you can act: continue the work here, or change the sidebar:");
  if (helperPath && task) lines.push(`- priority: node ${q(helperPath)} priority --space ${space} --terminal ${terminal} --task ${q(task.key)} --level high|normal|low --state ${q(stateDir)}`);
  if (helperPath) lines.push(`- refresh the task lists: node ${q(helperPath)} refresh --space ${space} --force --state ${q(stateDir)}`);
  else lines.push("- (the sidebar's commands run on the machine showing Herdr, not here)");
  const name = short(`Explain: ${task ? task.text : s.title ?? s.name ?? "session"}`, 48);
  const fork = s.file && (await fs.stat(s.file).catch(() => null)) ? s.file : null;
  if (!fork) fail("NO_JOURNAL", "this session's conversation wasn't found, so there is nothing to explain from yet");
  const folder = s.cwd || os.homedir();
  const prompt = lines.join("\n");
  return { kind: task ? "task" : "session", terminal, name, folder, fork, prompt, argv: launchArgv({ folder, fork, name, prompt }) };
}

const DESCRIBE = {
  name: "herdr-todos",
  version: VERSION,
  commands: {
    refresh: "refresh --space <id> [--state <dir>] [--model <provider/id>] [--force]: read the space's Pi sessions, update and print its task lists",
    show: "show --space <id> [--state <dir>]: print the cached task lists without reading sessions or calling a model",
    order: "order --space <id> --terminals t1,t2,...: set the session order, most important first (sessions not listed follow)",
    priority: "priority --space <id> --terminal <t> --task <key> --level high|normal|low: rank one task (keys are in each task's `key`)",
    explain: "explain --space <id> --terminal <t> [--task <key>]: the command that opens a Pi beside the session on a fork of its conversation (`pi --fork`), asked to explain the task or session and given the sidebar commands to act; open it with `herdr-app do pane.split '{\"pane\":...,\"direction\":\"right\",\"argv\":[...]}'`. Prints {kind, name, folder, fork, terminal, prompt, argv}",
    config: "config: the settings in force and where each value came from (default, user file, project file, environment). config set <key> <value> [--project [folder]]: write one after checking it (user file, or <project>/.herdr/todos.json). config unset <key> [--project]. config path: the two files",
    models: "models: the models Pi can call ({current, models: [provider/id...]}), from `pi --list-models`",
    describe: "this description",
  },
  output: {
    state: "ready | empty (no Pi sessions) | missing (never refreshed); busy: true when another refresh holds the space",
    prefs: "{order: [terminal...], priority: {\"<terminal>|<task key>\": high|low}} chosen by the person",
    sessions: "[{terminal, tab, rank (position in prefs.order or null), status (working|blocked|done|idle|error), name, title, now, root (git root), model, tasks: [{text, key, status: in_progress|todo|done|blocked, priority: high|normal|low}], source: board|haiku (a model wrote it)|none, mapping: label|name|name-newest|cached|newest|none, summarized_at, error}]",
    settings_problems: "what is wrong in a settings file, in words; the defaults are used for those values",
  },
  settings: describeSettings(),
  settings_order: "defaults < user file < project file (<git root>/.herdr/todos.json) < environment < --model",
  settings_files: { user: userSettingsFile(), project: "<project>/.herdr/todos.json", user_file_variable: "HERDR_TODOS_CONFIG" },
  state_dir: stateDir,
};

const cmd = args._[0];
try {
  if (cmd === "describe") {
    process.stdout.write(JSON.stringify(DESCRIBE, null, 1) + "\n");
  } else if (cmd === "config") {
    await configCommand();
  } else if (cmd === "models") {
    print(await listModels());
  } else if (cmd === "explain") {
    if (typeof args.space !== "string" || typeof args.terminal !== "string") fail("INVALID", "--space and --terminal are required");
    print(await explainTask(args.space, args.terminal, typeof args.task === "string" ? args.task : null));
  } else if (cmd === "order" || cmd === "priority") {
    if (typeof args.space !== "string") fail("INVALID", "--space <id> is required");
    const prefs = await readPrefs(args.space);
    if (cmd === "order") {
      if (typeof args.terminals !== "string") fail("INVALID", "--terminals t1,t2,... is required");
      prefs.order = [...new Set(args.terminals.split(",").map((x) => x.trim()).filter(Boolean))];
    } else {
      const { terminal, task, level } = args;
      if (typeof terminal !== "string" || typeof task !== "string") fail("INVALID", "--terminal and --task are required");
      if (!LEVELS.includes(level)) fail("INVALID", "--level is high, normal or low");
      const k = `${terminal}|${task}`;
      if (level === "normal") delete prefs.priority[k];
      else prefs.priority[k] = level;
    }
    await writeJsonAtomic(prefsFile(args.space), prefs);
    // Keep the cached lists in step so `show` and the sidebar agree without a refresh.
    const cached = await readJson(spaceFile(args.space), null);
    if (cached) await writeJsonAtomic(spaceFile(args.space), applyPrefs(cached, prefs));
    process.stdout.write(JSON.stringify({ space: args.space, prefs }) + "\n");
  } else if (cmd === "show" || cmd === "refresh") {
    if (typeof args.space !== "string") fail("INVALID", "--space <id> is required (a local Herdr space id, e.g. from `herdr-app status`)");
    if (args.space.includes("/")) fail("UNSUPPORTED", "Spaces on other machines are not supported");
    const doc =
      cmd === "show"
        ? await readJson(spaceFile(args.space), { version: VERSION, space: args.space, sessions: [], updated_at: null, state: "missing" })
        : await refresh(args.space, !!args.force);
    process.stdout.write(JSON.stringify(doc) + "\n");
  } else {
    fail("INVALID", `unknown command ${cmd ?? "(none)"}; try describe`);
  }
} catch (e) {
  fail("FAILED", String(e?.message || e));
}
