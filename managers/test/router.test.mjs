import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.join(here, "..", "router.mjs");
const fixtures = path.join(here, "fixtures");

function answersFor(yesIds) {
  return (items) =>
    items.map((item) => ({
      id: item.id,
      answer: yesIds.includes(item.id) ? "yes" : "no",
      jev: { confidence: 0.9 },
      source: "stub",
    }));
}

async function startStub() {
  const stub = { calls: [], respond: answersFor([]), hang: false };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { items } = JSON.parse(body);
      stub.calls.push({ token: req.headers["x-hswarm-token"], items });
      if (stub.hang) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: stub.respond(items), summary: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.port = server.address().port;
  stub.close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return stub;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runRouter(stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ROUTER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
}

async function withRig(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "managers-router-"));
  const managers = path.join(root, "managers");
  cpSync(fixtures, managers, { recursive: true });
  writeFileSync(path.join(root, "console-token"), "test-token\n");
  const stub = await startStub();
  const env = (extra = {}) => {
    const base = { ...process.env };
    delete base.AGENTHYDRA_MANAGER;
    delete base.AGENTHYDRA_CLIMAYTE_WORKER;
    delete base.AGENTHYDRA_CLIMAYTE_CHAT;
    delete base.HYDRA_DESK_CHAT_ID;
    return {
      ...base,
      AGENTHYDRA_MANAGERS_DIR: managers,
      AGENTHYDRA_CONSOLE_TOKEN_FILE: path.join(root, "console-token"),
      AGENTHYDRA_JEV_PORT: String(stub.port),
      ...extra,
    };
  };
  const rig = { root, managers, stub, env, sessionFile: (id) => path.join(managers, "sessions", `${id}.json`) };
  rig.readSession = (id) => JSON.parse(readFileSync(rig.sessionFile(id), "utf8"));
  rig.readLog = () => readFileSync(path.join(managers, "router.log"), "utf8");
  try {
    await fn(rig);
  } finally {
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const UI_BRIEF = "FIXTURE-BRIEF-ALPHA";
const BACKEND_BRIEF = "FIXTURE-BRIEF-BETA";

test("Jev answers swap the session from the UI manager to the backend manager", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    mkdirSync(path.join(rig.managers, "broken"));
    writeFileSync(path.join(rig.managers, "broken", "persona.json"), "{ nope");

    rig.stub.respond = answersFor(["domain:alpha-ui"]);
    const first = await runRouter({ session_id: "sess-1", prompt: "the button layout on the screen" }, rig.env({ AGENTHYDRA_JEV_PORT: String(rig.stub.port) }));
    assert.equal(first.code, 0, first.stderr);
    const out1 = JSON.parse(first.stdout);
    assert.equal(out1.systemMessage, "Now: Ada, Interface Design Lead");
    assert.match(out1.hookSpecificOutput.additionalContext, /FIXTURE-BRIEF-ALPHA/);
    assert.equal(rig.stub.calls[0].token, "test-token");
    assert.equal(rig.readSession("sess-1").manager, "alpha-ui");
    assert.equal(rig.readSession("sess-1").messages, 1);
    assert.match(rig.readLog(), /skipped broken: persona\.json/);

    rig.stub.respond = answersFor(["domain:beta-backend"]);
    const second = await runRouter({ session_id: "sess-1", prompt: "the api endpoint writes to the database" }, rig.env());
    const out2 = JSON.parse(second.stdout);
    assert.equal(out2.systemMessage, "Now: Ben, Backend Engineer");
    assert.match(out2.hookSpecificOutput.additionalContext, /FIXTURE-BRIEF-BETA/);
    const state = rig.readSession("sess-1");
    assert.equal(state.manager, "beta-backend");
    assert.equal(state.messages, 2);
    assert.equal(state.history.length, 2);
    assert.equal(state.history[1].manager, "beta-backend");
    const log = rig.readLog().trim().split("\n").filter((line) => line.includes("session=sess-1"));
    assert.equal(log.length, 2);
    assert.match(log[0], /SWAP .*source=jev/);
    assert.match(log[1], /SWAP .*source=jev/);
    assert.equal(rig.stub.calls.length, 2);
  });
});

test("every twelfth message re-injects the full brief, the others get one reminder line", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    mkdirSync(rig.managers + "/sessions", { recursive: true });
    writeFileSync(
      rig.sessionFile("sess-12"),
      JSON.stringify({ manager: "alpha-ui", since: "2026-10-01T00:00:00.000Z", pinned: false, messages: 10, lastFullAt: 1, history: [] }),
    );
    const env = rig.env();

    const eleventh = JSON.parse((await runRouter({ session_id: "sess-12", prompt: "continue" }, env)).stdout);
    const reminder = eleventh.hookSpecificOutput.additionalContext;
    assert.ok(!reminder.includes(UI_BRIEF));
    assert.match(reminder, /^Manager Hydra: still Ada \(Interface Design Lead\)\. Brief: .*brief\.md\.$/);
    assert.equal(rig.readSession("sess-12").lastFullAt, 1);

    const twelfth = JSON.parse((await runRouter({ session_id: "sess-12", prompt: "continue" }, env)).stdout);
    const full = twelfth.hookSpecificOutput.additionalContext;
    assert.match(full, /FIXTURE-BRIEF-ALPHA/);
    assert.match(full, /re-injected at message 12/);
    assert.equal(rig.readSession("sess-12").lastFullAt, 12);
    assert.equal(rig.stub.calls.length, 0, "a continuation never calls Jev");
  });
});

test("a Jev timeout falls back to keywords and names the reason in the output", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    rig.stub.hang = true;
    const result = await runRouter({ session_id: "sess-timeout", prompt: "api endpoint" }, rig.env());
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /^Manager Hydra routing note: Jev unavailable \(timed out after 4000 ms\); keywords used\./);
    assert.match(out.hookSpecificOutput.additionalContext, /FIXTURE-BRIEF-BETA/);
    assert.match(out.systemMessage, /keywords used/);
    assert.equal(rig.readSession("sess-timeout").manager, "beta-backend");
    assert.match(rig.readLog(), /source=keywords/);
  });
});

test("a Jev that answers every item with an error (a spent key) falls back to keywords and names Jev's error", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    rig.stub.respond = (items) =>
      items.map((item) => ({ id: item.id, answer: null, source: "none", jev: { error: "every key is out of credit" } }));
    const result = await runRouter({ session_id: "sess-spent", prompt: "api endpoint" }, rig.env());
    const out = JSON.parse(result.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /^Manager Hydra routing note: Jev answered nothing \(every key is out of credit\); keywords used\./);
    assert.equal(rig.readSession("sess-spent").manager, "beta-backend");
    assert.match(rig.readLog(), /source=keywords/);
  });
});

test("a closed Jev port falls back to keywords and names the port", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const port = await freePort();
    const result = await runRouter(
      { session_id: "sess-closed", prompt: "the button layout on the screen" },
      rig.env({ AGENTHYDRA_JEV_PORT: String(port) }),
    );
    const out = JSON.parse(result.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`^Manager Hydra routing note: Jev unavailable \\(no HSwarm server on 127\\.0\\.0\\.1:${port}`));
    assert.match(out.hookSpecificOutput.additionalContext, /FIXTURE-BRIEF-ALPHA/);
    assert.equal(rig.readSession("sess-closed").manager, "alpha-ui");
  });
});

test("AGENTHYDRA_MANAGER pins the manager without a Jev call, and the pin holds in the session", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const pinned = await runRouter(
      { session_id: "sess-pin", prompt: "the button layout on the screen" },
      rig.env({ AGENTHYDRA_MANAGER: "floor-quick" }),
    );
    const out1 = JSON.parse(pinned.stdout);
    assert.equal(out1.systemMessage, "Now: Fred, Floor Manager");
    assert.match(out1.hookSpecificOutput.additionalContext, /FIXTURE-BRIEF-FLOOR/);
    assert.equal(rig.readSession("sess-pin").pinned, true);

    const later = await runRouter({ session_id: "sess-pin", prompt: "the api endpoint writes to the database" }, rig.env());
    const out2 = JSON.parse(later.stdout);
    assert.match(out2.hookSpecificOutput.additionalContext, /^Manager Hydra: still Fred/);
    assert.equal(rig.readSession("sess-pin").manager, "floor-quick");
    assert.match(rig.readLog(), /pinned in session/);
    assert.equal(rig.stub.calls.length, 0);
  });
});

test("an unknown AGENTHYDRA_MANAGER is named in the output and the log", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const result = await runRouter({ session_id: "sess-bad-pin", prompt: "hello" }, rig.env({ AGENTHYDRA_MANAGER: "nobody" }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).systemMessage, "Manager Hydra error: AGENTHYDRA_MANAGER names no manager: nobody");
    assert.match(rig.readLog(), /ERROR AGENTHYDRA_MANAGER names no manager: nobody/);
    assert.equal(existsSync(rig.sessionFile("sess-bad-pin")), false);
  });
});

test("a CliMayte worker session is skipped without output or state", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const result = await runRouter({ session_id: "sess-worker", prompt: "the button layout on the screen" }, rig.env({ AGENTHYDRA_CLIMAYTE_WORKER: "1" }));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(path.join(rig.managers, "sessions")), false);
    assert.equal(rig.stub.calls.length, 0);
  });
});

test("a Desk chat, a CliMayte chat with the worker flag, is still routed", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    rig.stub.respond = answersFor(["domain:alpha-ui"]);
    const result = await runRouter(
      { session_id: "sess-desk", prompt: "the button layout on the screen" },
      rig.env({ AGENTHYDRA_CLIMAYTE_WORKER: "w-1", AGENTHYDRA_CLIMAYTE_CHAT: "1" }),
    );
    assert.equal(JSON.parse(result.stdout).systemMessage, "Now: Ada, Interface Design Lead");
    assert.equal(rig.readSession("sess-desk").manager, "alpha-ui");
  });
});

test("a message opening with @Name picks that manager without a Jev call", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const result = await runRouter({ session_id: "sess-at", prompt: "@ben is the button layout on the screen right?" }, rig.env());
    assert.equal(JSON.parse(result.stdout).systemMessage, "Now: Ben, Backend Engineer");
    assert.equal(rig.readSession("sess-at").manager, "beta-backend");
    assert.equal(rig.stub.calls.length, 0);
  });
});

test("a slash command is skipped without output or state", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const result = await runRouter({ session_id: "sess-slash", prompt: "/help" }, rig.env());
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(path.join(rig.managers, "sessions")), false);
    assert.equal(rig.stub.calls.length, 0);
  });
});

test("no personas gives no output and writes nothing", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    rmSync(rig.managers, { recursive: true, force: true });
    mkdirSync(rig.managers);
    const result = await runRouter({ session_id: "sess-empty", prompt: "the button layout on the screen" }, rig.env());
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(path.join(rig.managers, "sessions")), false);
    assert.equal(existsSync(path.join(rig.managers, "router.log")), false);
  });
});

test("an unusable session id is named as an error", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const result = await runRouter({ session_id: "../evil", prompt: "the button layout on the screen" }, rig.env());
    assert.equal(JSON.parse(result.stdout).systemMessage, "Manager Hydra error: hook input has no usable session_id");
    assert.match(rig.readLog(), /ERROR hook input has no usable session_id/);
  });
});

const analyticsLines = (rig) =>
  readFileSync(path.join(rig.managers, "analytics", "routes.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

test("each routed message writes one analytics line for a pin, a pinned stay, an @name swap and a continuation stay", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const transcript = path.join(rig.root, "transcripts", "sess-pin.jsonl");
    const cwd = path.join(rig.root, "work");
    const pinPrompt = "FIXTURE-PROMPT-ONE the button layout on the screen";
    await runRouter(
      { session_id: "sess-pin", prompt: pinPrompt, transcript_path: transcript, cwd },
      rig.env({ AGENTHYDRA_MANAGER: "floor-quick", HYDRA_DESK_CHAT_ID: "desk-7" }),
    );
    await runRouter({ session_id: "sess-pin", prompt: "the api endpoint writes to the database" }, rig.env());
    await runRouter({ session_id: "sess-at", prompt: "@ben is the button layout on the screen right?" }, rig.env());
    await runRouter({ session_id: "sess-at", prompt: "ok thanks" }, rig.env());

    const [pin, pinnedStay, atSwap, continuation] = analyticsLines(rig);
    assert.equal(analyticsLines(rig).length, 4);
    assert.deepEqual(Object.keys(pin).sort(), [
      "at", "cwd", "decision", "deskChat", "manager", "message", "p", "pinned", "promptChars", "session", "source", "transcriptPath", "v", "why",
    ]);
    assert.equal(pin.v, 1);
    assert.equal(pin.session, "sess-pin");
    assert.equal(pin.manager, "floor-quick");
    assert.equal(pin.decision, "swap");
    assert.equal(pin.why, "pinned by AGENTHYDRA_MANAGER");
    assert.equal(pin.source, "router");
    assert.equal(pin.p, null);
    assert.equal(pin.message, 1);
    assert.equal(pin.pinned, true);
    assert.equal(pin.deskChat, "desk-7");
    assert.equal(pin.cwd, cwd);
    assert.equal(pin.transcriptPath, transcript);
    assert.equal(pin.promptChars, pinPrompt.length);
    assert.equal(Number.isNaN(Date.parse(pin.at)), false);

    assert.equal(pinnedStay.decision, "stay");
    assert.equal(pinnedStay.why, "pinned in session");
    assert.equal(pinnedStay.message, 2);
    assert.equal(pinnedStay.deskChat, null);
    assert.equal(pinnedStay.transcriptPath, null);

    assert.equal(atSwap.session, "sess-at");
    assert.equal(atSwap.manager, "beta-backend");
    assert.equal(atSwap.decision, "swap");
    assert.equal(atSwap.why, "@Ben in the message");
    assert.equal(atSwap.source, "at-name");
    assert.equal(atSwap.pinned, false);
    assert.equal(atSwap.promptChars, "@ben is the button layout on the screen right?".length);

    assert.equal(continuation.manager, "beta-backend");
    assert.equal(continuation.decision, "stay");
    assert.equal(continuation.why, "continuation");
    assert.equal(continuation.source, "continuation");
    assert.equal(continuation.message, 2);
    assert.equal(continuation.promptChars, "ok thanks".length);
    assert.equal(rig.stub.calls.length, 0);
  });
});

test("an analytics line holds the prompt length and never the prompt text", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const secret = "FIXTURE-SECRET-PHRASE the api endpoint writes to the database";
    await runRouter({ session_id: "sess-text", prompt: `@ben ${secret}` }, rig.env());
    const raw = readFileSync(path.join(rig.managers, "analytics", "routes.jsonl"), "utf8");
    assert.equal(raw.includes("FIXTURE-SECRET-PHRASE"), false);
    assert.equal(analyticsLines(rig)[0].promptChars, `@ben ${secret}`.length);
  });
});

test("transcriptPath lands in the session file and the existing session fields are kept", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    const transcript = path.join(rig.root, "transcripts", "sess-t.jsonl");
    await runRouter({ session_id: "sess-t", prompt: "@ben the api endpoint", transcript_path: transcript }, rig.env());
    const state = rig.readSession("sess-t");
    assert.equal(state.transcriptPath, transcript);
    assert.equal(state.manager, "beta-backend");
    assert.equal(state.messages, 1);
    assert.equal(state.pinned, false);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].manager, "beta-backend");
    assert.equal(analyticsLines(rig)[0].transcriptPath, transcript);
  });
});

test("an unwritable analytics folder is named in the output and the log, and routing still happens", { timeout: 20000 }, async () => {
  await withRig(async (rig) => {
    writeFileSync(path.join(rig.managers, "analytics"), "not a folder");
    const result = await runRouter({ session_id: "sess-blocked", prompt: "@ben the api endpoint" }, rig.env());
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.match(out.systemMessage, /^Now: Ben, Backend Engineer\nManager Hydra error: analytics line not written \(/);
    assert.match(out.hookSpecificOutput.additionalContext, /FIXTURE-BRIEF-BETA/);
    assert.equal(rig.readSession("sess-blocked").manager, "beta-backend");
    assert.match(rig.readLog(), /session=sess-blocked analytics ERROR /);
  });
});
