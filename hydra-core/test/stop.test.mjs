import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { asksQuestion, handle } from "../hook.mjs";
import { defaultHookPath, install, uninstall } from "../install.mjs";

const CLEARED = ["HYDRA_DESK_CHAT_ID", "AGENTHYDRA_CLIMAYTE_WORKER", "AGENTHYDRA_CLIMAYTE_CHAT"];

async function withCore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hydra-core-stop-"));
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

const prompt = (text) => ({ type: "user", message: { role: "user", content: text } });
const says = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const uses = (name, input) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] },
});
const result = () => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
});

function stop(dir, entries, extra = {}) {
  const transcript = path.join(dir, "transcript.jsonl");
  writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return { hook_event_name: "Stop", session_id: "sess-stop", stop_hook_active: false, transcript_path: transcript, ...extra };
}

function turnOn(dir, catalog) {
  writeFileSync(path.join(dir, "ON"), "");
  if (catalog) {
    mkdirSync(path.join(dir, "catalog"), { recursive: true });
    writeFileSync(path.join(dir, "catalog", "hand-people.json"), JSON.stringify(catalog));
  }
}

const OWNERS = [
  { kind: "person", id: "person:creaitor", tier: "owner" },
  { kind: "person", id: "person:someone", tier: "employee" },
];

const fire = async (input, env) => (await handle(JSON.stringify(input), env)) ?? null;

test("blocks a trailing question with no owner consult and logs the block", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const input = stop(dir, [prompt("fix it"), says("Should I delete the old folder?")]);
    const out = await fire(input, envFor(dir));
    assert.equal(out.decision, "block");
    assert.match(out.reason, /ask the owner tier/);
    assert.match(out.reason, /person:creaitor/);
    const [line] = readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n");
    const logged = JSON.parse(line);
    assert.equal(logged.event, "president-block");
    assert.equal(logged.chat, "sess-stop");
  }));

test("allows after a core_use consult of an owner-tier person", () =>
  withCore(async (dir) => {
    turnOn(dir, OWNERS);
    const input = stop(dir, [
      prompt("fix it"),
      uses("mcp__agenthydra__core_use", { mode: "consult", id: "person:creaitor", question: "delete?" }),
      result(),
      says("Should I delete the old folder?"),
    ]);
    assert.equal(await fire(input, envFor(dir)), null);
  }));

test("a consult of a non-owner person does not count", () =>
  withCore(async (dir) => {
    turnOn(dir, OWNERS);
    const input = stop(dir, [
      prompt("fix it"),
      uses("mcp__agenthydra__core_use", { mode: "consult", id: "person:someone", question: "delete?" }),
      result(),
      says("Should I delete the old folder?"),
    ]);
    assert.equal((await fire(input, envFor(dir))).decision, "block");
  }));

test("allows after a Bash creaitor.py ask", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const input = stop(dir, [
      prompt("fix it"),
      uses("Bash", { command: "python ~/.claude/tools/creaitor.py ask 'delete the folder?'" }),
      result(),
      says("Should I delete the old folder?"),
    ]);
    assert.equal(await fire(input, envFor(dir)), null);
  }));

test("never blocks twice in a row", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const input = stop(dir, [prompt("fix it"), says("Should I delete the old folder?")], { stop_hook_active: true });
    assert.equal(await fire(input, envFor(dir)), null);
  }));

test("allows for a CliMayte worker", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const input = stop(dir, [prompt("fix it"), says("Should I delete the old folder?")]);
    assert.equal(await fire(input, envFor(dir, { AGENTHYDRA_CLIMAYTE_WORKER: "1" })), null);
  }));

test("allows when the final message has no question", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const input = stop(dir, [prompt("fix it"), says("Deleted the old folder.")]);
    assert.equal(await fire(input, envFor(dir)), null);
  }));

test("allows when the only question mark is inside a code block", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const input = stop(dir, [prompt("fix it"), says("Done.\n\n```js\nconst ok = x ? 1 : 2;\n```")]);
    assert.equal(await fire(input, envFor(dir)), null);
  }));

test("allows on a broken transcript (fail open)", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const transcript = path.join(dir, "broken.jsonl");
    writeFileSync(transcript, "{not json\n");
    const input = { hook_event_name: "Stop", session_id: "sess-stop", stop_hook_active: false, transcript_path: transcript };
    assert.equal(await fire(input, envFor(dir)), null);
  }));

test("decides from the last turn alone: a broken line before it changes nothing, and a turn over a chunk parses whole", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const transcript = path.join(dir, "long.jsonl");
    const big = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "é".repeat(600_000) }] } };
    const lines = [
      "{not json",
      prompt("old message"),
      says("Old question?"),
      prompt("fix it"),
      uses("Bash", { command: "ls" }),
      big,
      says("Should I delete the old folder?"),
    ].map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
    writeFileSync(transcript, lines.join("\n"));
    const input = { hook_event_name: "Stop", session_id: "sess-stop", stop_hook_active: false, transcript_path: transcript };
    assert.equal((await fire(input, envFor(dir))).decision, "block");
  }));

test("install adds Stop beside an existing Stop hook and uninstall removes only ours", () =>
  withCore(async (dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const other = { hooks: [{ type: "command", command: "node C:/Example/other-stop.mjs" }] };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [other] } }));
    install({ settingsPath, coreDir, hookPath: defaultHookPath() });
    const installed = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(installed.hooks.Stop.length, 2);
    assert.deepEqual(installed.hooks.Stop[0], other);
    assert.match(installed.hooks.Stop[1].hooks[0].command, /hook\.mjs"$/);
    uninstall({ settingsPath, coreDir });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { hooks: { Stop: [other] } });
  }));

test("a markdown heading ending in ? is a label, not a question", () => {
  assert.equal(asksQuestion("Done.\n\n## Am I 100% done?\nYes.\n\n## Do I recommend anything else?\nNothing."), false);
  assert.equal(asksQuestion("Done.\n\nShould I push this?"), true);
});
