#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTER_COMMAND = /[\\/]managers[\\/]router\.mjs"?\s*$/;

export function defaultSettingsPath(env = process.env) {
  return env.AGENTHYDRA_CLAUDE_SETTINGS || path.join(os.homedir(), ".claude", "settings.json");
}

export function defaultRouterPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "router.mjs");
}

const isRouterHook = (hook) => typeof hook?.command === "string" && ROUTER_COMMAND.test(hook.command);

function withoutRouterHooks(groups) {
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) {
      kept.push(group);
      continue;
    }
    const rest = group.hooks.filter((hook) => !isRouterHook(hook));
    if (rest.length === group.hooks.length) kept.push(group);
    else if (rest.length) kept.push({ ...group, hooks: rest });
  }
  return kept;
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

export function installHook({ settingsPath = defaultSettingsPath(), routerPath = defaultRouterPath() } = {}) {
  const settings = readSettings(settingsPath);
  const hooks = settings.data.hooks ?? {};
  const groups = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  const command = `node "${routerPath}"`;
  const next = {
    ...settings.data,
    hooks: { ...hooks, UserPromptSubmit: [...withoutRouterHooks(groups), { hooks: [{ type: "command", command }] }] },
  };
  return { settingsPath, ...writeSettings(settingsPath, settings, next) };
}

export function uninstallHook({ settingsPath = defaultSettingsPath() } = {}) {
  const settings = readSettings(settingsPath);
  if (!settings.existed) return { settingsPath, changed: false, backup: null };
  const next = { ...settings.data };
  if (settings.data.hooks) {
    const hooks = { ...settings.data.hooks };
    if (Array.isArray(hooks.UserPromptSubmit)) {
      const rest = withoutRouterHooks(hooks.UserPromptSubmit);
      if (rest.length) hooks.UserPromptSubmit = rest;
      else delete hooks.UserPromptSubmit;
    }
    next.hooks = hooks;
  }
  return { settingsPath, ...writeSettings(settingsPath, settings, next) };
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf("--settings");
  const settingsPath = flag >= 0 && argv[flag + 1] ? path.resolve(argv[flag + 1]) : defaultSettingsPath();
  const uninstall = argv.includes("--uninstall");
  const result = uninstall ? uninstallHook({ settingsPath }) : installHook({ settingsPath });
  const state = result.changed ? "updated" : "already up to date";
  const backup = result.backup ? ` (backup ${result.backup})` : "";
  console.log(`${uninstall ? "uninstall" : "install"}: ${state} ${settingsPath}${backup}`);
}
