import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultHookPath, install, status, uninstall } from "../install.mjs";

const INSTALL = path.resolve(import.meta.dirname, "..", "install.mjs");
const coreGroup = { hooks: [{ type: "command", command: `node "${defaultHookPath()}"` }] };
const routerGroup = { hooks: [{ type: "command", command: 'node "C:/Example/managers/router.mjs"' }] };
const otherHook = { type: "command", command: "node C:/Example/other-hook.mjs" };

function withTemp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hydra-core-install-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

test("install adds the core hook to both events, keeps other hooks, and is a no-op the second time", () =>
  withTemp((dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const other = { hooks: [otherHook] };
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "dark", hooks: { PreToolUse: [other], UserPromptSubmit: [other] } }, null, 2),
    );

    const first = install({ settingsPath, coreDir });
    assert.equal(first.changed, true);
    assert.ok(first.backup && existsSync(first.backup), "a backup is written before a change");
    const after = readJson(settingsPath);
    assert.equal(after.theme, "dark");
    assert.deepStrictEqual(after.hooks.PreToolUse, [other]);
    assert.deepStrictEqual(after.hooks.UserPromptSubmit, [other, coreGroup]);
    assert.deepStrictEqual(after.hooks.SessionStart, [coreGroup]);

    const second = install({ settingsPath, coreDir });
    assert.equal(second.changed, false);
    assert.equal(second.backup, null);
    assert.deepStrictEqual(readJson(settingsPath), after);
    assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, 1);
  }));

test("install removes the router entry, and uninstall puts it back exactly", () =>
  withTemp((dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const original = { theme: "dark", hooks: { UserPromptSubmit: [routerGroup] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const installed = install({ settingsPath, coreDir });
    assert.equal(installed.routerRemoved, 1);
    assert.equal(status({ settingsPath, coreDir }).router, false);
    assert.equal(status({ settingsPath, coreDir }).core, true);
    assert.equal(status({ settingsPath, coreDir }).routerSaved, true);

    const removed = uninstall({ settingsPath, coreDir });
    assert.equal(removed.routerRestored, 1);
    assert.deepStrictEqual(readJson(settingsPath), original);
    assert.equal(status({ settingsPath, coreDir }).core, false);
    assert.equal(status({ settingsPath, coreDir }).routerSaved, false);
  }));

test("uninstall restores a router hook that shared a group with another hook", () =>
  withTemp((dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const mixed = { hooks: [otherHook, routerGroup.hooks[0]] };
    const original = { hooks: { UserPromptSubmit: [mixed] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    install({ settingsPath, coreDir });
    assert.deepStrictEqual(readJson(settingsPath).hooks.UserPromptSubmit, [{ hooks: [otherHook] }, coreGroup]);

    uninstall({ settingsPath, coreDir });
    assert.deepStrictEqual(readJson(settingsPath), original);
  }));

test("install creates a missing settings file, and uninstall on a missing file changes nothing", () =>
  withTemp((dir) => {
    const coreDir = path.join(dir, "core");
    const settingsPath = path.join(dir, "fresh", "settings.json");
    const made = install({ settingsPath, coreDir });
    assert.equal(made.changed, true);
    assert.equal(made.backup, null);
    assert.deepStrictEqual(readJson(settingsPath).hooks.SessionStart, [coreGroup]);

    const missing = path.join(dir, "none.json");
    const result = uninstall({ settingsPath: missing, coreDir });
    assert.equal(result.changed, false);
    assert.equal(existsSync(missing), false);
  }));

// Real subprocesses: a cold runner can take longer than bun's 5 s default.
test("the CLI works on a --settings file and --status reports both entries", { timeout: 20_000 }, () =>
  withTemp((dir) => {
    const settingsPath = path.join(dir, "custom", "settings.json");
    const env = { ...process.env, AGENTHYDRA_CORE_DIR: path.join(dir, "core") };
    const cli = (...args) => spawnSync(process.execPath, [INSTALL, ...args], { env, encoding: "utf8" });

    let r = cli("--status", "--settings", settingsPath);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /core: not installed/);

    r = cli("--settings", settingsPath);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /install: updated/);

    r = cli("--status", "--settings", settingsPath);
    assert.match(r.stdout, /core: installed/);

    r = cli("--uninstall", "--settings", settingsPath);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /uninstall: updated/);

    r = cli("--status", "--settings", settingsPath);
    assert.match(r.stdout, /core: not installed/);
  }));
