#!/usr/bin/env node
// A modelCmd for Todos when Pi reaches Claude through the pi-claude-bridge extension
// (models named claude-bridge/*) instead of an API key. See README, "Models through claude-bridge".
//
// It makes the same isolated `pi -p` call the widget makes (no session, tools, skills, prompts or
// context files), but loads the bridge extension: the widget's `-ne` would hide claude-bridge/*.
// stdin: {"model","system","input","thinking"} as JSON; stdout: the model's reply.
//
// Herdr starts the widget without your login shell's environment. Two things can go wrong there:
// - PATH finds a Node that pi does not run on. Name a folder with one that works in
//   `nodeBin` of pi-bridge-model.local.json beside this file (git-ignored), or PI_BRIDGE_NODE_BIN.
// - USER is missing, and the bridge then cannot find its login. It is filled in from the system.
// This script holds no credentials: the login stays where the bridge keeps it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localFile = join(here, "pi-bridge-model.local.json");
const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")) : {};

const BRIDGE = local.bridge || join(homedir(), ".pi/agent/npm/node_modules/pi-claude-bridge");
const NODE_BIN = process.env.PI_BRIDGE_NODE_BIN || local.nodeBin || null;

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { model, system, input, thinking } = JSON.parse(raw);

const env = {
  ...process.env,
  USER: process.env.USER || userInfo().username,
  LOGNAME: process.env.LOGNAME || userInfo().username,
  PATH: [NODE_BIN, join(homedir(), ".local/bin"), process.env.PATH ?? "/usr/bin:/bin"].filter(Boolean).join(":"),
  PI_NO_TITLE: "1",
};

const child = spawn(
  "pi",
  ["-p", "--no-session", "-ne", "-e", BRIDGE, "-nt", "-ns", "-np", "-nc", "--no-mcp", "--no-themes",
   "--thinking", thinking ?? "off", "--model", model, "--system-prompt", system],
  { stdio: ["pipe", "inherit", "inherit"], env },
);
child.on("error", (e) => {
  console.error(`pi could not start: ${e.message}`);
  process.exit(1);
});
child.stdin.end(input);
child.on("close", (code) => process.exit(code ?? 1));
