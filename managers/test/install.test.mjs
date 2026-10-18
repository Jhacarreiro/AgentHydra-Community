import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installHook, uninstallHook } from "../install.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "managers-install-"));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const routerCommands = (settings) =>
  (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));

test("install keeps existing hooks, adds one router group, and is a no-op the second time", () => {
  const dir = tmp();
  try {
    const settingsPath = path.join(dir, "settings.json");
    const otherGroup = { hooks: [{ type: "command", command: "node C:/tools/other-hook.mjs" }] };
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "dark", hooks: { PreToolUse: [otherGroup], UserPromptSubmit: [otherGroup] } }, null, 2),
    );
    const routerPath = path.join(dir, "managers", "router.mjs");

    const first = installHook({ settingsPath, routerPath });
    assert.equal(first.changed, true);
    assert.ok(first.backup && existsSync(first.backup), "a backup is written before a change");
    const after = readJson(settingsPath);
    assert.equal(after.theme, "dark");
    assert.deepEqual(after.hooks.PreToolUse, [otherGroup]);
    assert.deepEqual(routerCommands(after), [otherGroup.hooks[0].command, `node "${routerPath}"`]);

    const second = installHook({ settingsPath, routerPath });
    assert.equal(second.changed, false);
    assert.equal(second.backup, null);
    assert.deepEqual(readJson(settingsPath), after);
    assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install on a new router location replaces the old entry instead of adding a second one", () => {
  const dir = tmp();
  try {
    const settingsPath = path.join(dir, "settings.json");
    const oldRouter = path.join(dir, "old", "managers", "router.mjs");
    const newRouter = path.join(dir, "new", "managers", "router.mjs");
    installHook({ settingsPath, routerPath: oldRouter });
    const moved = installHook({ settingsPath, routerPath: newRouter });
    assert.equal(moved.changed, true);
    assert.deepEqual(routerCommands(readJson(settingsPath)), [`node "${newRouter}"`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install creates a missing settings file", () => {
  const dir = tmp();
  try {
    const settingsPath = path.join(dir, "fresh", "settings.json");
    const result = installHook({ settingsPath, routerPath: path.join(dir, "managers", "router.mjs") });
    assert.equal(result.changed, true);
    assert.equal(result.backup, null);
    assert.equal(routerCommands(readJson(settingsPath)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall removes only the router entries and keeps every other hook", () => {
  const dir = tmp();
  try {
    const settingsPath = path.join(dir, "settings.json");
    const otherGroup = { hooks: [{ type: "command", command: "node C:/tools/other-hook.mjs" }] };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { UserPromptSubmit: [otherGroup] } }));
    installHook({ settingsPath, routerPath: path.join(dir, "managers", "router.mjs") });

    const removed = uninstallHook({ settingsPath });
    assert.equal(removed.changed, true);
    assert.deepEqual(readJson(settingsPath).hooks, { UserPromptSubmit: [otherGroup] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall on a missing settings file changes nothing and creates nothing", () => {
  const dir = tmp();
  try {
    const settingsPath = path.join(dir, "settings.json");
    const result = uninstallHook({ settingsPath });
    assert.equal(result.changed, false);
    assert.equal(existsSync(settingsPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
