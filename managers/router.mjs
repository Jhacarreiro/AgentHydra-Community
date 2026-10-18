#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_JEV_PORT = 7793;
const JEV_TIMEOUT_MS = 4000;
const FULL_EVERY = 12;
const HISTORY_MAX = 50;
const BIG_WIN = 0.7;
const DOMAIN_WIN = 0.6;
const STAY_MIN = 0.45;
const SWAP_MARGIN = 0.25;
const KEYWORD_HIT = 0.6;
const KEYWORD_CAP = 0.9;
const ROLES = new Set(["domain", "coordinator", "floor"]);
const FILLER = new Set([
  "continue", "go", "on", "yes", "yeah", "yep", "ok", "okay", "sure", "do", "it", "keep", "going", "proceed",
  "ahead", "carry", "please", "pls", "thanks", "thank", "you", "next", "more", "again", "now", "fine", "great",
  "good", "right", "lgtm", "and", "the", "that", "this", "will", "one", "sounds",
]);
const QUESTIONS = {
  big: "Is this message a multi-part project that needs several fields worked in parallel?",
  quick: "Is this message a one-step ask (a fact, a status, a one-line edit)?",
};

const fmt = (n) => n.toFixed(2);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function managersDir(env = process.env) {
  return env.AGENTHYDRA_MANAGERS_DIR || path.join(os.homedir(), ".agenthydra", "managers");
}

export function personaProblem(persona, dir) {
  if (!persona || typeof persona !== "object" || Array.isArray(persona)) return "not a JSON object";
  for (const key of ["slug", "name", "title", "brief"]) {
    if (typeof persona[key] !== "string" || !persona[key].trim()) return `missing ${key}`;
  }
  if (!ROLES.has(persona.role)) return "role must be domain, coordinator or floor";
  if (persona.role === "domain" && (typeof persona.jev !== "string" || !persona.jev.trim())) {
    return "a domain manager needs a jev question";
  }
  if (!existsSync(path.join(dir, persona.brief))) return `brief not found: ${persona.brief}`;
  return null;
}

export function loadPersonas(root) {
  const personas = [];
  const skipped = [];
  if (!existsSync(root)) return { personas, skipped };
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const file = path.join(dir, "persona.json");
    if (!existsSync(file)) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      skipped.push({ folder: entry.name, reason: `persona.json: ${error.message}` });
      continue;
    }
    const problem = personaProblem(data, dir);
    if (problem) {
      skipped.push({ folder: entry.name, reason: problem });
      continue;
    }
    if (personas.some((p) => p.slug === data.slug)) {
      skipped.push({ folder: entry.name, reason: `duplicate slug ${data.slug}` });
      continue;
    }
    personas.push({
      ...data,
      dir,
      briefPath: path.join(dir, data.brief),
      keywords: Array.isArray(data.keywords) ? data.keywords.filter((k) => typeof k === "string") : [],
      playbook: Array.isArray(data.playbook) ? data.playbook : [],
    });
  }
  return { personas, skipped };
}

/** The manager a message opens with `@Name` or `@slug` names, or null: the owner's own pick, no Jev call. */
export function mentionedManager(prompt, personas) {
  const m = /^\s*@([A-Za-z][\w-]*)/.exec(String(prompt));
  if (!m) return null;
  const word = m[1].toLowerCase();
  return personas.find((p) => p.slug.toLowerCase() === word || p.name.toLowerCase() === word) ?? null;
}

export function isContinuation(prompt) {
  const words = String(prompt).toLowerCase().replace(/'/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  return words.length <= 4 && words.every((w) => FILLER.has(w));
}

function keywordScore(prompt, keywords) {
  const text = prompt.toLowerCase();
  const hits = keywords.filter((keyword) => {
    const word = keyword.toLowerCase().trim();
    return word && new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`).test(text);
  }).length;
  return Math.min(KEYWORD_CAP, KEYWORD_HIT * hits);
}

function keywordScores(prompt, personas) {
  const scores = { big: 0, quick: 0, domains: {} };
  for (const persona of personas) {
    if (persona.role === "domain") scores.domains[persona.slug] = keywordScore(prompt, persona.keywords);
    else if (persona.role === "coordinator") scores.big = keywordScore(prompt, persona.keywords);
    else if (persona.role === "floor") scores.quick = keywordScore(prompt, persona.keywords);
  }
  return scores;
}

export function pick(scores, current, personas) {
  const coordinator = personas.find((p) => p.role === "coordinator");
  const floor = personas.find((p) => p.role === "floor");
  const domains = personas.filter((p) => p.role === "domain");
  if (coordinator && scores.big >= BIG_WIN) {
    return { slug: coordinator.slug, why: `big ${fmt(scores.big)}`, p: scores.big };
  }
  let best = null;
  for (const domain of domains) {
    const p = scores.domains[domain.slug] ?? 0;
    if (!best || p > best.p) best = { slug: domain.slug, p };
  }
  const currentDomain = domains.find((d) => d.slug === current);
  const currentP = currentDomain ? (scores.domains[current] ?? 0) : 0;
  if (best && best.p >= DOMAIN_WIN) {
    if (currentDomain && best.slug === current) return { slug: current, why: `domain ${fmt(currentP)}`, p: currentP };
    if (currentDomain && currentP >= STAY_MIN && best.p - currentP < SWAP_MARGIN) {
      return {
        slug: current,
        why: `kept: ${fmt(currentP)} holds, ${best.slug} ${fmt(best.p)} is not ${SWAP_MARGIN} ahead`,
        p: currentP,
      };
    }
    return { slug: best.slug, why: `domain ${fmt(best.p)}`, p: best.p };
  }
  if (current && personas.some((p) => p.slug === current)) {
    return { slug: current, why: "no domain reached 0.6: kept", p: currentDomain ? currentP : null };
  }
  if (floor) return { slug: floor.slug, why: "no manager yet: floor", p: null };
  return { slug: null, why: "no manager fits", p: null };
}

function yesProbability(row) {
  if (!row) return null;
  const probs = row.jev?.probabilities;
  if (typeof probs?.yes === "number") return probs.yes;
  const confidence = row.jev?.confidence;
  if (typeof confidence !== "number") return null;
  if (row.answer === "yes") return confidence;
  if (row.answer === "no") return 1 - confidence;
  return null;
}

async function askJev(prompt, personas, env) {
  const port = Number(env.AGENTHYDRA_JEV_PORT) || DEFAULT_JEV_PORT;
  const tokenFile = env.AGENTHYDRA_CONSOLE_TOKEN_FILE || path.join(os.homedir(), ".hswarm", "console-token");
  let token;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error(`no console token at ${tokenFile}`);
  }
  const items = [
    { id: "big", state: prompt, type: "yesno", question: QUESTIONS.big },
    { id: "quick", state: prompt, type: "yesno", question: QUESTIONS.quick },
    ...personas
      .filter((p) => p.role === "domain")
      .map((p) => ({ id: `domain:${p.slug}`, state: prompt, type: "yesno", question: p.jev })),
  ];
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hswarm-token": token },
      body: JSON.stringify({ items, escalate_below: 0 }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error(`timed out after ${JEV_TIMEOUT_MS} ms`);
    throw new Error(`no HSwarm server on 127.0.0.1:${port} (${error.cause?.code ?? error.message})`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HSwarm answered ${res.status} with no JSON`);
  }
  if (!res.ok) throw new Error(`HSwarm answered ${res.status}: ${String(body?.error ?? text).slice(0, 160)}`);
  const rows = new Map((Array.isArray(body?.answers) ? body.answers : []).map((row) => [row.id, row]));
  const probs = Object.fromEntries(items.map((item) => [item.id, yesProbability(rows.get(item.id))]));
  // Why Jev left an item unanswered (a spent key, no network), so the routing note names the cause.
  const failed = [...rows.values()].find((row) => yesProbability(row) == null && (row.jev?.error || row.error));
  return { probs, error: failed ? String(failed.jev?.error || failed.error).slice(0, 200) : null };
}

async function scoreMessage(prompt, personas, env) {
  const fallback = keywordScores(prompt, personas);
  try {
    const { probs, error } = await askJev(prompt, personas, env);
    const unanswered = [];
    const value = (id, fb) => {
      if (probs[id] == null) {
        unanswered.push(id);
        return fb;
      }
      return probs[id];
    };
    const scores = { big: value("big", fallback.big), quick: value("quick", fallback.quick), domains: {} };
    for (const persona of personas) {
      if (persona.role === "domain") scores.domains[persona.slug] = value(`domain:${persona.slug}`, fallback.domains[persona.slug]);
    }
    const why = error ? ` (${error})` : "";
    if (unanswered.length === Object.keys(probs).length) {
      return { source: "keywords", scores: fallback, note: `Jev answered nothing${why}; keywords used` };
    }
    const note = unanswered.length ? `no Jev answer for ${unanswered.join(", ")}${why}; keywords used for those` : null;
    return { source: "jev", scores, note };
  } catch (error) {
    return { source: "keywords", scores: fallback, note: `Jev unavailable (${error.message}); keywords used` };
  }
}

export function buildInjection(persona, personas, { full, briefText = "", reason = "" }) {
  if (!full) return `Manager Hydra: still ${persona.name} (${persona.title}). Brief: ${persona.briefPath}.`;
  const playbook = persona.playbook.map(
    (entry) => `- ${entry.facet}: ${path.join(persona.dir, entry.file)} (read when: ${entry.read_when})`,
  );
  const roster = personas
    .filter((p) => p.slug !== persona.slug)
    .map(
      (p) =>
        `- ${p.name}, ${p.title} (${p.role}, slug ${p.slug}): ${p.oneLiner ?? ""} Bring in with manager_open { manager: "${p.slug}", prompt, title? }.`,
    );
  return [
    `Manager Hydra: you are ${persona.name}, ${persona.title}${reason ? ` (${reason})` : ""}. Brief: ${persona.briefPath}.`,
    "",
    briefText.trim(),
    "",
    "Playbook index (read a file only when its line matches the question):",
    ...(playbook.length ? playbook : ["- none"]),
    "",
    "Roster:",
    ...(roster.length ? roster : ["- none"]),
  ].join("\n");
}

function readState(file) {
  if (!existsSync(file)) return { manager: null, since: null, pinned: false, messages: 0, lastFullAt: 0, history: [] };
  return JSON.parse(readFileSync(file, "utf8"));
}

export async function run(input, env = process.env) {
  // A CliMayte worker is an employee, not a manager; a Desk chat runs as a CliMayte chat and is routed.
  if (env.AGENTHYDRA_CLIMAYTE_WORKER && !env.AGENTHYDRA_CLIMAYTE_CHAT) return null;
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (prompt.trimStart().startsWith("/")) return null;
  const root = managersDir(env);
  const { personas, skipped } = loadPersonas(root);
  if (!personas.length) return null;
  const at = new Date().toISOString();
  const logFile = path.join(root, "router.log");
  for (const s of skipped) appendFileSync(logFile, `${at} skipped ${s.folder}: ${s.reason}\n`);
  const sessionId = String(input.session_id ?? "");
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) throw new Error("hook input has no usable session_id");
  const sessionFile = path.join(root, "sessions", `${sessionId}.json`);
  const state = readState(sessionFile);
  const current = personas.some((p) => p.slug === state.manager) ? state.manager : null;
  const messages = state.messages + 1;
  const envPin = (env.AGENTHYDRA_MANAGER ?? "").trim();
  const mentioned = mentionedManager(prompt, personas);

  let decision;
  let source = "router";
  let note = null;
  if (envPin) {
    if (!personas.some((p) => p.slug === envPin)) throw new Error(`AGENTHYDRA_MANAGER names no manager: ${envPin}`);
    decision = { slug: envPin, why: "pinned by AGENTHYDRA_MANAGER", p: null };
  } else if (state.pinned && current) {
    decision = { slug: current, why: "pinned in session", p: null };
  } else if (mentioned) {
    source = "at-name";
    decision = { slug: mentioned.slug, why: `@${mentioned.name} in the message`, p: null };
  } else if (current && isContinuation(prompt)) {
    source = "continuation";
    decision = { slug: current, why: "continuation", p: null };
  } else {
    const scored = await scoreMessage(prompt, personas, env);
    source = scored.source;
    note = scored.note;
    decision = pick(scored.scores, current, personas);
  }

  const persona = personas.find((p) => p.slug === decision.slug) ?? null;
  const swapped = persona !== null && persona.slug !== current;
  const full = persona !== null && (swapped || messages % FULL_EVERY === 0);
  const briefText = full ? readFileSync(persona.briefPath, "utf8") : "";
  const reason = swapped ? (current ? `swapped from ${current}` : "assigned") : `re-injected at message ${messages}`;
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : null;
  const next = {
    manager: persona ? persona.slug : null,
    since: swapped ? at : state.since,
    pinned: Boolean(envPin) || state.pinned,
    messages,
    lastFullAt: full ? messages : state.lastFullAt,
    history: swapped
      ? [...state.history, { at, manager: persona.slug, why: decision.why, p: decision.p }].slice(-HISTORY_MAX)
      : state.history,
    transcriptPath,
  };
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify(next, null, 2)}\n`);
  const p = decision.p == null ? "" : ` p=${fmt(decision.p)}`;
  const noteText = note ? ` note="${note}"` : "";
  appendFileSync(
    logFile,
    `${at} session=${sessionId} manager=${next.manager ?? "none"} ${swapped ? "SWAP" : "stay"} (${decision.why}${p}) source=${source} message=${messages}${full ? " full" : ""}${noteText}\n`,
  );
  if (!persona) return null;

  let analyticsError = null;
  try {
    mkdirSync(path.join(root, "analytics"), { recursive: true });
    const line = {
      v: 1,
      at,
      session: sessionId,
      manager: persona.slug,
      decision: swapped ? "swap" : "stay",
      why: decision.why,
      source,
      p: decision.p ?? null,
      message: messages,
      pinned: next.pinned,
      deskChat: env.HYDRA_DESK_CHAT_ID || null,
      cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
      transcriptPath,
      promptChars: prompt.length,
    };
    appendFileSync(path.join(root, "analytics", "routes.jsonl"), `${JSON.stringify(line)}\n`);
  } catch (error) {
    analyticsError = error.message;
    appendFileSync(logFile, `${at} session=${sessionId} analytics ERROR ${error.message}\n`);
  }

  const injection = buildInjection(persona, personas, { full, briefText, reason });
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: note ? `Manager Hydra routing note: ${note}.\n${injection}` : injection,
    },
  };
  const messageLines = [];
  if (swapped) messageLines.push(`Now: ${persona.name}, ${persona.title}${note ? ` (${note})` : ""}`);
  if (analyticsError) messageLines.push(`Manager Hydra error: analytics line not written (${analyticsError})`);
  if (messageLines.length) output.systemMessage = messageLines.join("\n");
  return output;
}

export async function main(text, env = process.env) {
  try {
    return await run(JSON.parse(text || "{}"), env);
  } catch (error) {
    try {
      appendFileSync(path.join(managersDir(env), "router.log"), `${new Date().toISOString()} ERROR ${error.message}\n`);
    } catch (logError) {
      return { systemMessage: `Manager Hydra error: ${error.message} (router.log not written: ${logError.message})` };
    }
    return { systemMessage: `Manager Hydra error: ${error.message}` };
  }
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const output = await main(text);
  if (output) process.stdout.write(JSON.stringify(output));
}
