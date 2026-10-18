#!/usr/bin/env node
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVENTS = new Set(["UserPromptSubmit", "SessionStart", "Stop"]);
const LEAD_CAP = 20000;
const TAIL_CHUNK = 1 << 20;
export const PACK_TIMEOUT_MS = 1500;
const OWNER_FALLBACK = /^person:(creaitor|seat-)/;
const ASK_CREAITOR = /creaitor(?:\.py)?\s+ask\b/;
const BLOCK_REASON =
  'Before you ask the person, ask the owner tier (core_use { mode: "consult", id: "person:creaitor", question } or the creaitor.py ask command); ask the person only if that answer says it needs them (a credential, money, a physical step); otherwise act on the answer.';

export function coreDir(env = process.env) {
  return env.AGENTHYDRA_CORE_DIR || path.join(os.homedir(), ".agenthydra", "core");
}

export function isWorker(env = process.env) {
  return Boolean(env.AGENTHYDRA_CLIMAYTE_WORKER) && !env.AGENTHYDRA_CLIMAYTE_CHAT;
}

function seatChatOf(dir, deskChat) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "seat-chats.json"), "utf8"))[deskChat] ?? null;
  } catch {
    return null;
  }
}

/** Why this session gets nothing from Hydra Core (ROLES.md: seats keep their own persona, drones get no pack or
 *  persona), or null for a Prime or the owner's own chat. A CliMayte launch names the role in AGENTHYDRA_ROLE; a Desk
 *  chat core_use opened as a seat is listed in seat-chats.json. */
export function skipOf(env = process.env, dir = coreDir(env)) {
  const role = (env.AGENTHYDRA_ROLE ?? "").trim();
  if (role === "seat") return { role, why: "a seat keeps its own persona: no pack, lead or lead change (AGENTHYDRA_ROLE=seat)" };
  if (role === "drone") return { role, why: "a drone gets no pack or persona (AGENTHYDRA_ROLE=drone)" };
  const deskChat = (env.HYDRA_DESK_CHAT_ID ?? "").trim();
  const seat = deskChat ? seatChatOf(dir, deskChat) : null;
  if (seat) {
    return { role: "seat", why: `Desk chat is a seat of ${seat.persona} (seat-chats.json): it keeps its own persona` };
  }
  if (role !== "prime" && isWorker(env)) {
    return {
      role: "drone",
      why: "started from a CliMayte worker's shell (AGENTHYDRA_CLIMAYTE_WORKER set, AGENTHYDRA_CLIMAYTE_CHAT unset): treated as a drone",
    };
  }
  return null;
}

function logSkip(input, env, dir, skip) {
  try {
    let chat = null;
    try {
      chat = chatKey(input, env);
    } catch {}
    const line = {
      at: new Date().toISOString(),
      event: "hook-skip",
      chat,
      hook: input.hook_event_name,
      role: skip.role,
      worker: env.AGENTHYDRA_CLIMAYTE_WORKER || null,
      why: skip.why,
    };
    appendFileSync(path.join(dir, "log.jsonl"), `${JSON.stringify(line)}\n`);
  } catch {}
}

export function chatKey(input, env = process.env) {
  const raw = (env.HYDRA_DESK_CHAT_ID ?? "").trim() || String(input.session_id ?? "").trim();
  if (!raw) throw new Error("no chat key: HYDRA_DESK_CHAT_ID is unset and the hook input has no session_id");
  const key = raw.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (key === "." || key === "..") throw new Error(`chat key "${raw}" is not a usable folder name`);
  return key;
}

export function parseHydraMd(text) {
  const tier = /Tier:\s*(\S+)/.exec(text)?.[1] ?? null;
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.startsWith("## Lead"));
  if (heading < 0) return { lead: null, leadPath: null, tier };
  const line = (lines.slice(heading + 1).find((item) => item.trim()) ?? "").trim();
  if (!line || line.startsWith("#")) return { lead: null, leadPath: null, tier };
  const at = line.indexOf("Full text:");
  const head = (at >= 0 ? line.slice(0, at) : line).trim();
  const name = head.split(" - ")[0].replace(/\.$/, "").trim();
  const leadPath = at >= 0 ? line.slice(at + "Full text:".length).trim() : "";
  return { lead: name && name.toLowerCase() !== "none" ? name : null, leadPath: leadPath || null, tier };
}

// Pings the manager sends into a chat (task notifications, "Not from the user") are not the owner's words.
const NOT_OWNER = /^(<task-notification>|\[[^\]\n]*\] Not from the user\.)/;

const fromOwner = (prompt) => !NOT_OWNER.test(prompt.trimStart());

// What AgentHydra wraps around the owner's words before the hook sees them (desk2/server/src/engine/system-text.ts reads
// the same shapes back out): the Send now and urgent prefaces, a handoff's note and document after the owner's message
// (climayte-lib continuationPrompt), and task notifications or reminders queued with the message.
const SENT_NOW = /^\s*\[Sent now: [^\]\n]*\]\s*\n/;
const URGENT = /^\s*AgentHydra stopped your previous turn mid-step to deliver this message from the orchestrator\.[^\n]*\n\n/;
const CONTINUED = /\n\n---\nAn earlier session already worked on this task /;
const CONTINUED_MESSAGES =
  /\n\nThe orchestrator also sent these messages, which the earlier session did not get to:\n([\s\S]*?)\n\n--- HANDOFF ---\n/;
const QUEUED = /<(task-notification|system-reminder)>[\s\S]*?<\/\1>/g;

/** The owner's own words in a prompt: what the per-message additions are scored on and prompt.txt records. */
export function ownerText(prompt) {
  let text = prompt.replace(SENT_NOW, "").replace(URGENT, "");
  const at = text.search(CONTINUED);
  if (at >= 0) {
    const list = CONTINUED_MESSAGES.exec(text.slice(at))?.[1]?.trim() ?? "";
    const later = list ? list.replace(/^- /, "").split("\n- ").map((m) => m.trim()) : [];
    text = [text.slice(0, at), ...later].filter(Boolean).join("\n\n");
  }
  return text.replace(QUEUED, "").trim();
}

// A prompt the hook acts on, as the owner's words; null for a command, a ping, or nothing left once the wrappers go.
function ownerPrompt(input) {
  const prompt = String(input.prompt ?? "");
  if (prompt.trimStart().startsWith("/") || !fromOwner(prompt)) return null;
  return ownerText(prompt) || null;
}

function sessionText(hydraPath, hydraText) {
  const { leadPath } = parseHydraMd(hydraText);
  let text = `Hydra Core: this chat's hydra.md (${hydraPath}):\n\n${hydraText.trimEnd()}`;
  if (leadPath && path.isAbsolute(leadPath) && existsSync(leadPath)) {
    const lead = readFileSync(leadPath, "utf8");
    const body =
      lead.length > LEAD_CAP
        ? `${lead.slice(0, LEAD_CAP)}\n[cut at ${LEAD_CAP} of ${lead.length} characters; the rest is in ${leadPath}]`
        : lead;
    text += `\n\nLead full text (${leadPath}):\n${body}`;
  }
  return text;
}

const output = (hookEventName, additionalContext) => ({ hookSpecificOutput: { hookEventName, additionalContext } });

const cwdOf = (input) => (typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());

function recordPrompt(input, env, dir, prompt) {
  const key = chatKey(input, env);
  const chatDir = path.join(dir, "chats", key);
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(path.join(chatDir, "prompt.txt"), prompt);
  writeFileSync(path.join(chatDir, "cwd.txt"), cwdOf(input));
  const hydraPath = path.join(chatDir, "hydra.md");
  const hydraText = existsSync(hydraPath) ? readFileSync(hydraPath, "utf8") : null;
  return { key, hydraPath, hydraText };
}

function userPromptSubmit(input, env, dir) {
  const prompt = ownerPrompt(input);
  if (!prompt) return null;
  recordPrompt(input, env, dir, prompt);
  return null;
}

// A compaction drops the additions the session was sent (the slot stays: it is in the system prompt), so the session's
// sent.json list is cleared and they can go again.
function forgetSent(input, env, dir) {
  if (input.source !== "compact") return;
  const file = path.join(dir, "chats", chatKey(input, env), "sent.json");
  const session = String(input.session_id ?? "");
  try {
    const sent = JSON.parse(readFileSync(file, "utf8"));
    if (!Object.hasOwn(sent, session)) return;
    delete sent[session];
    writeFileSync(file, JSON.stringify(sent, null, 2));
  } catch {}
}

function injectOn(dir) {
  const file = path.join(dir, "INJECT");
  return existsSync(file) && readFileSync(file, "utf8").trim() === "ON";
}

function placementOf(dir) {
  const file = path.join(dir, "PLACEMENT");
  if (!existsSync(file)) return "off";
  const raw = readFileSync(file, "utf8").trim();
  return raw === "slot" || raw === "file" || raw === "attach" ? raw : "off";
}

// Under slot or file the pack is already in the chat's prompt: a message gets only the strong matches it has not had.
async function placedPrompt(input, env, dir) {
  const prompt = ownerPrompt(input);
  if (!prompt) return null;
  const { key } = recordPrompt(input, env, dir, prompt);
  try {
    const match = await requestPack(
      { chat: key, session: String(input.session_id ?? key), cwd: cwdOf(input), prompt, placement: placementOf(dir) },
      env,
    );
    return match.text ? output("UserPromptSubmit", match.text) : null;
  } catch (error) {
    return output("UserPromptSubmit", `Hydra Core pack unavailable: ${error.message}`);
  }
}

// A file chat's first turn either opened its pack.md or did not: one pack_read line per session.
function logPackRead(input, env, dir) {
  if (placementOf(dir) !== "file" || input.stop_hook_active === true) return;
  try {
    const key = chatKey(input, env);
    const chatDir = path.join(dir, "chats", key);
    const session = String(input.session_id ?? key);
    const marker = path.join(chatDir, "pack-read.txt");
    if (existsSync(marker) && readFileSync(marker, "utf8") === session) return;
    const { tools } = lastTurn(input);
    const packPath = path.resolve(chatDir, "pack.md");
    const read = tools.some((tool) => tool.name === "Read" && path.resolve(String(tool.input?.file_path ?? "")) === packPath);
    writeFileSync(marker, session);
    appendFileSync(
      path.join(dir, "log.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), event: "pack_read", chat: key, session, read, firstTool: tools[0]?.name ?? null })}\n`,
    );
  } catch {}
}

async function requestPack(req, env) {
  const base = env.AGENTHYDRA_DAEMON_URL || "http://127.0.0.1:7787";
  const res = await fetch(`${base}/api/core/pack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(PACK_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `the daemon answered ${res.status}`);
  return body;
}

async function injectPrompt(input, env, dir) {
  const prompt = ownerPrompt(input);
  if (!prompt) return null;
  const { key } = recordPrompt(input, env, dir, prompt);
  try {
    const pack = await requestPack(
      { chat: key, session: String(input.session_id ?? key), cwd: cwdOf(input), prompt },
      env,
    );
    return pack.text ? output("UserPromptSubmit", pack.text) : null;
  } catch (error) {
    return output("UserPromptSubmit", `Hydra Core pack unavailable: ${error.message}`);
  }
}

// A resumed session still holds every pack it was sent (a chat that resumes for each message would otherwise get
// the full pack every time); a session that never got one gets its first pack with its next message. Only a
// compaction drops what was sent, so only a compaction resends it.
async function injectSession(input, env, dir) {
  if (input.source !== "compact") return null;
  const key = chatKey(input, env);
  try {
    const pack = await requestPack(
      { chat: key, session: String(input.session_id ?? key), cwd: cwdOf(input), prompt: "", full: true },
      env,
    );
    return pack.text ? output("SessionStart", pack.text) : null;
  } catch (error) {
    const old = sessionStart(input, env, dir);
    const note = `Hydra Core pack unavailable: ${error.message}`;
    if (!old) return output("SessionStart", note);
    return output("SessionStart", `${old.hookSpecificOutput.additionalContext}\n${note}`);
  }
}

function sessionStart(input, env, dir) {
  if (input.source !== "compact" && input.source !== "resume") return null;
  const hydraPath = path.join(dir, "chats", chatKey(input, env), "hydra.md");
  if (!existsSync(hydraPath)) return null;
  return output("SessionStart", sessionText(hydraPath, readFileSync(hydraPath, "utf8")));
}

function isRealPrompt(entry) {
  if (entry.message?.role !== "user") return false;
  const content = entry.message.content;
  if (typeof content === "string") return content.trim() !== "";
  return Array.isArray(content) && content.some((block) => block?.type === "text");
}

const blocksOf = (entry) => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

/**
 * The entries after the transcript's last real prompt, read backwards from the end, so a long chat's
 * history is never read or parsed (a 375 MB transcript took 11 s and 1.1 GB when read whole).
 * Lines are cut at newline bytes before decoding, so a chunk edge inside a character is harmless.
 */
function turnEntries(file) {
  const fd = openSync(file, "r");
  try {
    const entries = [];
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    const take = (bytes) => {
      const line = bytes.toString("utf8").trim();
      if (!line) return false;
      const entry = JSON.parse(line);
      if (isRealPrompt(entry)) return true;
      entries.push(entry);
      return false;
    };
    while (pos > 0) {
      const size = Math.min(TAIL_CHUNK, pos);
      pos -= size;
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, pos);
      const buf = Buffer.concat([chunk, carry]);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        if (take(buf.subarray(i + 1, end))) return entries.reverse();
        end = i;
      }
      carry = buf.subarray(0, end);
    }
    take(carry);
    return entries.reverse();
  } finally {
    closeSync(fd);
  }
}

function lastTurn(input) {
  const entries = turnEntries(input.transcript_path);
  const assistant = entries.filter((entry) => entry.message?.role === "assistant");
  const last = assistant.at(-1);
  const text =
    typeof input.last_assistant_message === "string"
      ? input.last_assistant_message
      : blocksOf(last)
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("\n");
  const tools = assistant.flatMap((entry) => blocksOf(entry).filter((block) => block?.type === "tool_use"));
  return { text, tools };
}

export function asksQuestion(text) {
  // Markdown headings are labels, not questions (the recap's "## Am I 100% done?" ends every reply).
  const prose = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/^#{1,6}\s.*$/gm, "");
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return /\?(?=\s|$)/.test(paragraphs.at(-1) ?? "");
}

function ownerIds(dir) {
  const ids = new Set();
  const catalog = path.join(dir, "catalog");
  if (!existsSync(catalog)) return ids;
  for (const name of readdirSync(catalog)) {
    if (!/^(generated|hand)-.*\.json$/.test(name)) continue;
    try {
      for (const entry of JSON.parse(readFileSync(path.join(catalog, name), "utf8"))) {
        if (entry?.kind === "person" && entry.tier === "owner" && typeof entry.id === "string") ids.add(entry.id);
      }
    } catch {}
  }
  return ids;
}

function isOwner(id, dir) {
  const owners = ownerIds(dir);
  return owners.size ? owners.has(id) : OWNER_FALLBACK.test(id);
}

function consults(tool, dir) {
  const input = tool.input ?? {};
  if (typeof tool.name === "string" && tool.name.endsWith("core_use")) {
    return input.mode === "consult" && typeof input.id === "string" && isOwner(input.id, dir);
  }
  if (tool.name === "Bash" || tool.name === "PowerShell") return ASK_CREAITOR.test(String(input.command ?? ""));
  return false;
}

function logBlock(input, env, dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const chat = chatKey(input, env);
    appendFileSync(path.join(dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event: "president-block", chat })}\n`);
  } catch {}
}

function stopCheck(input, env, dir) {
  if (input.stop_hook_active === true) return null;
  try {
    const { text, tools } = lastTurn(input);
    if (!asksQuestion(text)) return null;
    if (tools.some((tool) => consults(tool, dir))) return null;
  } catch {
    return null;
  }
  logBlock(input, env, dir);
  return { decision: "block", reason: BLOCK_REASON };
}

export async function run(input, env = process.env) {
  const event = input.hook_event_name;
  if (!EVENTS.has(event)) throw new Error(`unexpected hook_event_name "${event}"`);
  const dir = coreDir(env);
  if (!existsSync(path.join(dir, "ON"))) return null;
  const skip = skipOf(env, dir);
  if (skip) {
    if (event !== "Stop") logSkip(input, env, dir, skip);
    return null;
  }
  if (event === "Stop") {
    logPackRead(input, env, dir);
    return stopCheck(input, env, dir);
  }
  const placement = placementOf(dir);
  if (placement === "slot" || placement === "file") {
    if (event === "UserPromptSubmit") return placedPrompt(input, env, dir);
    forgetSent(input, env, dir);
    return null;
  }
  if (injectOn(dir) || placement === "attach") {
    return event === "UserPromptSubmit" ? injectPrompt(input, env, dir) : injectSession(input, env, dir);
  }
  return event === "UserPromptSubmit" ? userPromptSubmit(input, env, dir) : sessionStart(input, env, dir);
}

export async function handle(text, env = process.env) {
  let input = null;
  try {
    input = JSON.parse(text.trim() ? text : "{}");
    return await run(input, env);
  } catch (error) {
    if (input && EVENTS.has(input.hook_event_name)) {
      return output(input.hook_event_name, `Hydra Core hook error: ${error.message}`);
    }
    throw error;
  }
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const result = await handle(text);
    if (result) process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`Hydra Core hook: ${error.message}\n`);
    process.exitCode = 1;
  }
}
