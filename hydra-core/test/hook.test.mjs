import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chatKey, handle, parseHydraMd, run } from "../hook.mjs";

const HOOK = path.resolve(import.meta.dirname, "..", "hook.mjs");
const CLEARED = ["HYDRA_DESK_CHAT_ID", "AGENTHYDRA_CLIMAYTE_WORKER", "AGENTHYDRA_CLIMAYTE_CHAT", "AGENTHYDRA_ROLE"];

async function withCore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hydra-core-hook-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function envFor(dir, extra = {}) {
  const env = { ...process.env, AGENTHYDRA_CORE_DIR: dir };
  for (const key of CLEARED) delete env[key];
  return { ...env, ...extra };
}

const turn = (prompt, extra = {}) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: "sess-1",
  prompt,
  cwd: "C:/Users/me/project",
  ...extra,
});

const turnOn = (dir) => writeFileSync(path.join(dir, "ON"), "");

function hydraMd(leadPath, tier = 2) {
  return [
    "# hydra.md",
    `Updated: 2026-10-13T09:00:00Z  Tier: ${tier}  Team: 1`,
    "## Lead (become)",
    `Example Lead - Example Title. Full text: ${leadPath}`,
    "## Under you",
    "## Tools",
    "## Knowledge",
    "## Plan",
    "Example plan line.",
    "## Scope log",
    "",
  ].join("\n");
}

test("a CliMayte worker gets no output and no files", () => withCore(async (dir) => {
  turnOn(dir);
  assert.equal(await run(turn("move notes"), envFor(dir, { AGENTHYDRA_CLIMAYTE_WORKER: "1" })), null);
  assert.equal(existsSync(path.join(dir, "chats")), false);
}));

test("a CliMayte chat (worker with a chat id) is not skipped", () => withCore(async (dir) => {
  turnOn(dir);
  const env = envFor(dir, { AGENTHYDRA_CLIMAYTE_WORKER: "1", AGENTHYDRA_CLIMAYTE_CHAT: "c-1" });
  assert.equal(await run(turn("move notes"), env), null);
  assert.equal(existsSync(path.join(dir, "chats", "sess-1", "prompt.txt")), true);
}));

const skips = (dir) =>
  existsSync(path.join(dir, "log.jsonl"))
    ? readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line)).filter((e) => e.event === "hook-skip")
    : [];

test("a seat launched by CliMayte gets no pack and no lead change, and the skip is logged", () => withCore(async (dir) => {
  turnOn(dir);
  const env = envFor(dir, {
    AGENTHYDRA_CLIMAYTE_WORKER: "w-seat",
    AGENTHYDRA_CLIMAYTE_CHAT: "1",
    AGENTHYDRA_ROLE: "seat",
    HYDRA_DESK_CHAT_ID: "desk-seat-1",
  });
  assert.equal(await run(turn("what do you think of the plan?"), env), null);
  assert.equal(await run({ hook_event_name: "SessionStart", session_id: "sess-1", cwd: "C:/Users/me/project" }, env), null);
  assert.equal(existsSync(path.join(dir, "chats")), false);
  const logged = skips(dir);
  assert.equal(logged.length, 2);
  assert.equal(logged[0].chat, "desk-seat-1");
  assert.equal(logged[0].role, "seat");
  assert.equal(logged[0].hook, "UserPromptSubmit");
  assert.match(logged[0].why, /seat/);
}));

test("a Desk chat listed in seat-chats.json is a seat: no pack, no lead change, skip logged", () => withCore(async (dir) => {
  turnOn(dir);
  writeFileSync(path.join(dir, "seat-chats.json"), JSON.stringify({ "desk-seat-2": { persona: "person:example", parent: "desk-prime" } }));
  const env = envFor(dir, { HYDRA_DESK_CHAT_ID: "desk-seat-2" });
  assert.equal(await run(turn("what do you think of the plan?"), env), null);
  assert.equal(existsSync(path.join(dir, "chats")), false);
  const [skip] = skips(dir);
  assert.equal(skip.chat, "desk-seat-2");
  assert.equal(skip.role, "seat");
  assert.match(skip.why, /person:example/);
}));

test("a drone gets nothing from the hook, and the skip is logged", () => withCore(async (dir) => {
  turnOn(dir);
  const env = envFor(dir, { AGENTHYDRA_CLIMAYTE_WORKER: "w-drone", AGENTHYDRA_ROLE: "drone" });
  assert.equal(await run(turn("fix the test"), env), null);
  assert.equal(existsSync(path.join(dir, "chats")), false);
  const [skip] = skips(dir);
  assert.equal(skip.role, "drone");
  assert.equal(skip.worker, "w-drone");
}));

test("a chat started from a worker shell is skipped with a logged reason", () => withCore(async (dir) => {
  turnOn(dir);
  const env = envFor(dir, { AGENTHYDRA_CLIMAYTE_WORKER: "w-shell", HYDRA_DESK_CHAT_ID: "desk-from-worker" });
  assert.equal(await run(turn("keep going"), env), null);
  assert.equal(existsSync(path.join(dir, "chats")), false);
  const [skip] = skips(dir);
  assert.equal(skip.chat, "desk-from-worker");
  assert.equal(skip.worker, "w-shell");
  assert.match(skip.why, /AGENTHYDRA_CLIMAYTE_WORKER/);
}));

test("a Prime CliMayte chat (role prime) is not skipped and logs no skip", () => withCore(async (dir) => {
  turnOn(dir);
  const env = envFor(dir, { AGENTHYDRA_CLIMAYTE_WORKER: "w-prime", AGENTHYDRA_CLIMAYTE_CHAT: "1", AGENTHYDRA_ROLE: "prime" });
  await run(turn("move notes"), env);
  assert.equal(existsSync(path.join(dir, "chats", "sess-1", "prompt.txt")), true);
  assert.deepEqual(skips(dir), []);
}));

test("slash commands and a missing ON flag produce no output and write nothing", () => withCore(async (dir) => {
  assert.equal(await run(turn("move notes"), envFor(dir)), null);
  assert.equal(existsSync(path.join(dir, "chats")), false);
  turnOn(dir);
  assert.equal(await run(turn("  /clear"), envFor(dir)), null);
  assert.equal(existsSync(path.join(dir, "chats")), false);
}));

test("the chat key is the Desk chat id when set, else the session id, made filename-safe", () => {
  assert.equal(chatKey({ session_id: "sess-1" }, {}), "sess-1");
  assert.equal(chatKey({ session_id: "sess-1" }, { HYDRA_DESK_CHAT_ID: "desk-7" }), "desk-7");
  assert.equal(chatKey({ session_id: "a/b c" }, {}), "a_b_c");
  assert.throws(() => chatKey({ session_id: ".." }, {}), /not a usable folder name/);
  assert.throws(() => chatKey({}, {}), /no chat key/);
});

test("UserPromptSubmit writes prompt.txt and cwd.txt and injects nothing (the core is injected, not asked)", () => withCore(async (dir) => {
  turnOn(dir);
  const out = await run(turn("move notes.txt into the archive"), envFor(dir));
  assert.equal(out, null);
  const chat = path.join(dir, "chats", "sess-1");
  assert.equal(readFileSync(path.join(chat, "prompt.txt"), "utf8"), "move notes.txt into the archive");
  assert.equal(readFileSync(path.join(chat, "cwd.txt"), "utf8"), "C:/Users/me/project");
}));

test("a non-owner ping injects nothing and writes no prompt.txt", () => withCore(async (dir) => {
  turnOn(dir);
  assert.equal(await run(turn("[climayte] Not from the user. Status: done."), envFor(dir)), null);
  assert.equal(existsSync(path.join(dir, "chats", "sess-1", "prompt.txt")), false);
}));

test("parseHydraMd reads the lead name, its full-text path and the tier", () => {
  assert.deepStrictEqual(parseHydraMd(hydraMd("C:/Example/lead.md", 2)), {
    lead: "Example Lead",
    leadPath: "C:/Example/lead.md",
    tier: "2",
  });
  assert.deepStrictEqual(parseHydraMd("# hydra.md\nUpdated: x  Tier: 1\n## Lead (become)\nnone\n"), {
    lead: null,
    leadPath: null,
    tier: "1",
  });
});

test("SessionStart after a compact re-injects hydra.md and the lead's full text", () => withCore(async (dir) => {
  turnOn(dir);
  const chat = path.join(dir, "chats", "sess-1");
  mkdirSync(chat, { recursive: true });
  const leadPath = path.join(dir, "lead.md");
  writeFileSync(leadPath, "LEAD BRIEF TEXT");
  writeFileSync(path.join(chat, "hydra.md"), hydraMd(leadPath));
  const out = await run({ hook_event_name: "SessionStart", session_id: "sess-1", source: "compact" }, envFor(dir));
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /Example plan line\./);
  assert.match(text, /LEAD BRIEF TEXT/);
  assert.doesNotMatch(text, /cut at/);
}));

test("SessionStart cuts a lead text longer than 20000 characters and says so", () => withCore(async (dir) => {
  turnOn(dir);
  const chat = path.join(dir, "chats", "sess-1");
  mkdirSync(chat, { recursive: true });
  const leadPath = path.join(dir, "lead.md");
  writeFileSync(leadPath, "@".repeat(25000));
  writeFileSync(path.join(chat, "hydra.md"), hydraMd(leadPath));
  const text = (await run({ hook_event_name: "SessionStart", session_id: "sess-1", source: "resume" }, envFor(dir)))
    .hookSpecificOutput.additionalContext;
  assert.equal(text.split("@").length - 1, 20000);
  assert.ok(text.includes("cut at 20000 of 25000 characters"));
}));

test("SessionStart on a fresh startup injects nothing", () => withCore(async (dir) => {
  turnOn(dir);
  assert.equal(await run({ hook_event_name: "SessionStart", session_id: "sess-1", source: "startup" }, envFor(dir)), null);
}));

test("a hook error is named in the output, not swallowed", () => withCore(async (dir) => {
  turnOn(dir);
  const out = await handle(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), envFor(dir));
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /Hydra Core hook error: no chat key/);
}));

test("an unknown hook event is an error", () => withCore(async (dir) => {
  await assert.rejects(() => handle(JSON.stringify({ hook_event_name: "PreToolUse" }), envFor(dir)), /unexpected hook_event_name "PreToolUse"/);
}));

// Real subprocesses: a cold runner can take longer than bun's 5 s default.
test("the hook runs as a process: nothing on stdout for a legacy prompt, exit 1 for an unknown event", { timeout: 20_000 }, () => withCore(async (dir) => {
  turnOn(dir);
  const ok = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(turn("move notes")),
    env: envFor(dir),
    encoding: "utf8",
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "");
  const bad = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "PreToolUse" }),
    env: envFor(dir),
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unexpected hook_event_name "PreToolUse"/);
}));
