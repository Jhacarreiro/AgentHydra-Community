#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const EVENTS = ["UserPromptSubmit", "SessionStart", "Stop"];
const CORE_COMMAND = /[\\/]hydra-core[\\/]hook\.mjs"?\s*$/;
const ROUTER_COMMAND = /[\\/]managers[\\/]router\.mjs"?\s*$/;
const RECORD_FILE = "router-entry.json";

export function defaultSettingsPath(env = process.env) {
  return env.AGENTHYDRA_CLAUDE_SETTINGS || path.join(os.homedir(), ".claude", "settings.json");
}

export function defaultCoreDir(env = process.env) {
  return env.AGENTHYDRA_CORE_DIR || path.join(os.homedir(), ".agenthydra", "core");
}

export function defaultHookPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "hook.mjs");
}

const isCore = (hook) => typeof hook?.command === "string" && CORE_COMMAND.test(hook.command);
const isRouter = (hook) => typeof hook?.command === "string" && ROUTER_COMMAND.test(hook.command);
const listOf = (value) => (Array.isArray(value) ? value : []);
const hasHook = (group, test) => Array.isArray(group?.hooks) && group.hooks.some(test);

function removeHooks(groups, test) {
  const kept = [];
  for (const group of groups) {
    if (!hasHook(group, test)) {
      kept.push(group);
      continue;
    }
    const rest = group.hooks.filter((hook) => !test(hook));
    if (rest.length) kept.push({ ...group, hooks: rest });
  }
  return kept;
}

function routerRecords(groups) {
  const records = [];
  groups.forEach((group, index) => {
    if (!hasHook(group, isRouter)) return;
    const rest = group.hooks.filter((hook) => !isRouter(hook));
    records.push({ index, original: group, trimmed: rest.length ? { ...group, hooks: rest } : null });
  });
  return records;
}

function upsertCore(groups, command) {
  if (!groups.some((group) => hasHook(group, isCore))) return [...groups, { hooks: [{ type: "command", command }] }];
  return groups.map((group) =>
    hasHook(group, isCore)
      ? { ...group, hooks: group.hooks.map((hook) => (isCore(hook) ? { ...hook, command } : hook)) }
      : group,
  );
}

function restoreRouter(groups, records) {
  const list = [...groups];
  for (const { index, original, trimmed } of records) {
    const at = trimmed ? list.findIndex((group) => isDeepStrictEqual(group, trimmed)) : -1;
    if (at >= 0) {
      list[at] = original;
      continue;
    }
    const routerOnly = { ...original, hooks: original.hooks.filter(isRouter) };
    if (!list.some((group) => isDeepStrictEqual(group, routerOnly))) {
      list.splice(Math.min(index, list.length), 0, routerOnly);
    }
  }
  return list;
}

function readSettings(file) {
  if (!existsSync(file)) return { existed: false, data: {} };
  const text = readFileSync(file, "utf8");
  let data;
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  return { existed: true, data };
}

function writeSettings(file, { existed, data }, next) {
  if (existed && JSON.stringify(data) === JSON.stringify(next)) return { changed: false, backup: null };
  let backup = null;
  if (existed) {
    backup = `${file}.bak-${Date.now()}`;
    copyFileSync(file, backup);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, backup };
}

function readRecords(dir) {
  const file = path.join(dir, RECORD_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function writeRecords(dir, records) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, RECORD_FILE), `${JSON.stringify(records, null, 2)}\n`);
}

export function install({
  settingsPath = defaultSettingsPath(),
  coreDir = defaultCoreDir(),
  hookPath = defaultHookPath(),
} = {}) {
  const file = path.resolve(settingsPath);
  const settings = readSettings(file);
  const hooks = { ...(settings.data.hooks ?? {}) };
  const command = `node "${hookPath}"`;
  const saved = readRecords(coreDir);
  const found = {};
  for (const event of EVENTS) {
    const groups = listOf(hooks[event]);
    const records = routerRecords(groups);
    if (records.length) found[event] = records;
    hooks[event] = upsertCore(removeHooks(groups, isRouter), command);
  }
  const routerRemoved = Object.values(found).reduce((count, records) => count + records.length, 0);
  const write = writeSettings(file, settings, { ...settings.data, hooks });
  if (routerRemoved) writeRecords(coreDir, { ...saved, [file]: { ...(saved[file] ?? {}), ...found } });
  return { settingsPath: file, ...write, routerRemoved };
}

export function uninstall({ settingsPath = defaultSettingsPath(), coreDir = defaultCoreDir() } = {}) {
  const file = path.resolve(settingsPath);
  const settings = readSettings(file);
  if (!settings.existed) return { settingsPath: file, changed: false, backup: null, routerRestored: 0 };
  const hooks = { ...(settings.data.hooks ?? {}) };
  const saved = readRecords(coreDir);
  const records = saved[file] ?? {};
  let routerRestored = 0;
  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event]) && !records[event]) continue;
    const before = listOf(hooks[event]);
    const entries = listOf(records[event]);
    routerRestored += entries.length;
    const groups = restoreRouter(removeHooks(before, isCore), entries);
    if (groups.length || !before.length) hooks[event] = groups;
    else delete hooks[event];
  }
  const next = { ...settings.data };
  if (Object.keys(hooks).length || settings.data.hooks !== undefined) next.hooks = hooks;
  else delete next.hooks;
  const write = writeSettings(file, settings, next);
  if (saved[file]) {
    delete saved[file];
    writeRecords(coreDir, saved);
  }
  return { settingsPath: file, ...write, routerRestored };
}

export function status({ settingsPath = defaultSettingsPath(), coreDir = defaultCoreDir() } = {}) {
  const file = path.resolve(settingsPath);
  const hooks = readSettings(file).data.hooks ?? {};
  const core = EVENTS.every((event) => listOf(hooks[event]).some((group) => hasHook(group, isCore)));
  const router = EVENTS.some((event) => listOf(hooks[event]).some((group) => hasHook(group, isRouter)));
  return { settingsPath: file, core, router, routerSaved: Boolean(readRecords(coreDir)[file]) };
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const argv = process.argv.slice(2);
    const flag = (name) => {
      const at = argv.indexOf(name);
      if (at < 0) return null;
      if (!argv[at + 1]) throw new Error(`${name} needs a value`);
      return argv[at + 1];
    };
    const given = flag("--settings");
    const settingsPath = given ? path.resolve(given) : defaultSettingsPath();
    if (argv.includes("--status")) {
      const s = status({ settingsPath });
      console.log(`core: ${s.core ? "installed" : "not installed"}`);
      const saved = s.routerSaved ? " (entry saved, --uninstall puts it back)" : "";
      console.log(`router: ${s.router ? "installed" : "not installed"}${saved}`);
    } else if (argv.includes("--uninstall")) {
      const r = uninstall({ settingsPath });
      const state = r.changed ? "updated" : "already clean";
      const backup = r.backup ? ` (backup ${r.backup})` : "";
      console.log(`uninstall: ${state} ${settingsPath}${backup}; router entries restored: ${r.routerRestored}`);
    } else {
      const r = install({ settingsPath });
      const state = r.changed ? "updated" : "already up to date";
      const backup = r.backup ? ` (backup ${r.backup})` : "";
      const router = r.routerRemoved ? `; router entries removed: ${r.routerRemoved}` : "";
      console.log(`install: ${state} ${settingsPath}${backup}${router}`);
    }
  } catch (error) {
    console.error(`hydra-core install: ${error.message}`);
    process.exitCode = 1;
  }
}
