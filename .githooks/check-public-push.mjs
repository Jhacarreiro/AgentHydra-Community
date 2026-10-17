#!/usr/bin/env node
/**
 * Pre-push guard: rules that used to live only in people's memory, and the public-safety audit.
 *
 *  1. A push to a PUBLIC remote is refused unless this one command was told to proceed.
 *     LunarWerxs/AgentHydra is public, and a push to `main` is a release for every source install
 *     (docs/RELEASING.md). The standing rule is "check visibility, announce it with an unmissable
 *     heading, then let the owner decide". On 2026-09-11 (590bec8) a session that had not read the
 *     rule pushed a peer's half-finished work straight to origin/main with no announcement. Nothing
 *     secret went out that day; the rule that stops the day something does had no teeth. Now the
 *     heading is printed by the machine, every time, and the push stops there unless
 *     AGENTHYDRA_PUSH_PUBLIC=1 is set for that command - which announces AND proceeds, because the
 *     rule was always announce-then-do, never announce-instead-of-do.
 *
 *  2. A release tag (refs/tags/v*) is refused while the repository's own work queue has an open
 *     section. Owner directive (2026-09-11): "We always do everything now... If something
 *     is pending a to-do, it should be to-done before we do the upcoming release." The queue is
 *     docs/todo/TODO.md, gitignored and local, so this gate can only fire on a machine that holds
 *     it; a clone without the file has nothing to gate on and passes. There is deliberately NO
 *     override for this rule: the item gets done, or the owner deletes it himself.
 *
 *  3. A release tag is refused when scripts/release-notes.mjs would refuse to publish it: a version
 *     below 2.0.0, or a long CHANGELOG section with no TL;DR. On 2026-10-06 the owner asked "why do
 *     we keep releasing updates to GitHub on the 1.x path of Agent Hydra?" (1.11.0 to 1.13.0 had
 *     shipped from another PC on the old line), and of the release page "We always need to do it
 *     like Sage does": a TL;DR, then the detail under "read more". release.yml runs the same check;
 *     here it stops the tag before it reaches GitHub. No override, as for rule 2.
 *
 *  4. No ref may carry upstream's relicensing commit. AgentHydra Community is built from 3a65ba8e,
 *     the last commit LunarWerxs/AgentHydra published under MIT; the very next one, aee9dfc4, moved
 *     AgentHydra to the PolyForm Noncommercial license, and nothing from it on may be published
 *     from this checkout. A merge or rebase onto upstream's main would bring it in without a single
 *     changed file saying so, so the history of every pushed ref is checked, on every push to any
 *     remote. scripts/audit-public.config.json may name a further boundary commit; it can only add
 *     to this one. No override.
 *
 *  5. scripts/audit-public.mjs runs over what the push carries (its --push mode: the commits the
 *     remote does not have yet, from the base commit on): tokens and keys, credential files, private
 *     addresses, email addresses, home paths, upstream's hosts and private repositories, binaries
 *     with no provenance, and commit emails that are not noreply. It runs for every remote, private
 *     ones too: this repository is public by design, a private repository can be made public later,
 *     and "private" here can also mean "does not exist yet". A finding that is fine goes in
 *     scripts/audit-public.allow.json; there is no override. An audit that gives no verdict (it
 *     cannot load, start or finish) refuses the push as well, and says so rather than calling it a
 *     finding. A checkout without the script has nothing to audit with and passes, as for rule 3.
 *
 * VISIBILITY IS FAIL-CLOSED. A remote that is not GitHub, a lookup that times out, a rate limit -
 * every "could not tell" is treated as public. A guard that passes when it cannot see is a guard
 * that passes exactly when something is wrong. `--no-verify` still skips this hook, which a hook
 * cannot prevent; the bundling path (scripts/save-bundle.ts) never uses it, on purpose.
 *
 * Usage (git's pre-push hook calls it; see .githooks/pre-push):
 *   node .githooks/check-public-push.mjs <remote-name> <remote-url>
 *   stdin: one "<local ref> <local sha> <remote ref> <remote sha>" line per ref being pushed
 * Env:
 *   AGENTHYDRA_PUSH_PUBLIC=1         announce, then allow a public push (this one command)
 *   AGENTHYDRA_VISIBILITY_STUB=...   public | private | unknown - tests only, skips the network
 *   GH_TOKEN / GITHUB_TOKEN          optional; sent with the lookup so a rate limit cannot turn a
 *                                    private repo into "unknown"
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PUBLIC_HEADING = "# WARNING: THIS REPOSITORY IS **PUBLIC**";
const LOOKUP_TIMEOUT_MS = 5000;
const ZERO_SHA = /^0+$/;
const RELEASE_TAG = /^refs\/tags\/v\d+\.\d+\.\d+/;
const TODO_FILE = "docs/todo/TODO.md";
// Rule 4: upstream's commit "AgentHydra is now under the PolyForm Noncommercial License".
export const LICENSE_BOUNDARY = "aee9dfc4f7dd0228d8e1740be90b646b30204f37";
const AUDIT_SCRIPT = "scripts/audit-public.mjs";
const AUDIT_CONFIG = "scripts/audit-public.config.json";

const [remoteName = "", remoteUrl = ""] = process.argv.slice(2);

/** owner/repo from any of the URL shapes git accepts for GitHub, or null for anything else. */
export function parseGithubSlug(url) {
  const m =
    /^(?:https?:\/\/|ssh:\/\/)?(?:[\w.-]+@)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** 'public' | 'private' | 'unknown', with the sentence that explains it. */
export async function lookupVisibility(url, env = process.env) {
  const stub = (env.AGENTHYDRA_VISIBILITY_STUB || "").trim().toLowerCase();
  if (stub === "public" || stub === "private" || stub === "unknown") {
    return { verdict: stub, reason: `AGENTHYDRA_VISIBILITY_STUB=${stub}` };
  }
  const slug = parseGithubSlug(url);
  if (!slug) {
    return {
      verdict: "unknown",
      reason: `${url || "(no url)"} is not a GitHub remote, so its visibility cannot be looked up`,
    };
  }
  const api = `https://api.github.com/repos/${slug.owner}/${slug.repo}`;
  // `connection: close`: Node's fetch keeps the socket alive otherwise, and on Windows a
  // process.exit() while that socket is still closing trips a libuv assertion
  // (`!(handle->flags & UV_HANDLE_CLOSING)`, exit 127) AFTER the verdict has printed - which
  // turned a correct "private, pass" into a refusal on the first hand test (2026-09-12).
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "agenthydra-pre-push",
    connection: "close",
  };
  const token = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(api, { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { verdict: "unknown", reason: `GET ${api} failed (${why})` };
  }
  if (res.status === 404) {
    // Unauthenticated, a private repo and a nonexistent one both answer 404. Either way there is
    // nothing public at that slug.
    return { verdict: "private", reason: `GET ${api} -> 404 (private, or not on GitHub)` };
  }
  if (res.status === 200) {
    let visibility = "";
    try {
      visibility = String((await res.json())?.visibility || "");
    } catch {
      /* fall through: a 200 we cannot read is not proof of privacy */
    }
    if (visibility === "public") {
      return { verdict: "public", reason: `GET ${api} -> 200, visibility: public` };
    }
    if (visibility === "private" || visibility === "internal") {
      return { verdict: "private", reason: `GET ${api} -> 200, visibility: ${visibility}` };
    }
    return { verdict: "unknown", reason: `GET ${api} -> 200 with no readable visibility field` };
  }
  return { verdict: "unknown", reason: `GET ${api} -> HTTP ${res.status}` };
}

/** The refs git is about to push, from the hook's stdin. */
export function parseRefLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha, isDelete: ZERO_SHA.test(localSha || "") };
    });
}

/**
 * The open sections of the work queue: every `## ` heading after the "## Contents" heading. When
 * the file has no Contents heading, every `## ` heading except the state-of-play one counts. A
 * missing file is an empty queue - there is nothing local to gate on.
 */
export function openTodoSections(todoPath) {
  if (!existsSync(todoPath)) return [];
  const lines = readFileSync(todoPath, "utf8").split(/\r?\n/);
  const contentsAt = lines.findIndex((l) => /^## Contents\b/.test(l));
  const scope = contentsAt >= 0 ? lines.slice(contentsAt + 1) : lines;
  return scope
    .filter((l) => /^## /.test(l))
    .map((l) => l.replace(/^## /, "").trim())
    .filter((h) => contentsAt >= 0 || !/STATE OF PLAY/i.test(h));
}

/** Rule 4's commits: LICENSE_BOUNDARY, plus the audit config's licenseBoundary when it names another. */
export function licenseBoundaries(cwd = process.cwd()) {
  const out = [LICENSE_BOUNDARY];
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, ...AUDIT_CONFIG.split("/")), "utf8"));
    const extra = String(cfg?.licenseBoundary || "").toLowerCase();
    if (/^[0-9a-f]{40}$/.test(extra) && !out.includes(extra)) out.push(extra);
  } catch {
    /* no config, or an unreadable one: the constant above still holds */
  }
  return out;
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Rule 4: each pushed ref whose history holds one of `boundaries`, with the reason. A boundary commit
 * this clone does not have cannot be in any of its refs' history, so it is skipped; a git answer
 * that is neither yes nor no refuses (fail closed).
 */
export function licenseRefusals(refs, boundaries, cwd = process.cwd()) {
  const out = [];
  for (const boundary of boundaries) {
    if (git(["cat-file", "-e", `${boundary}^{commit}`], cwd).status !== 0) continue;
    for (const r of refs) {
      if (r.isDelete) continue;
      const peeled = git(["rev-parse", "--verify", "--quiet", `${r.localSha}^{commit}`], cwd);
      const commit = (peeled.stdout || "").trim();
      if (!commit) continue; // a tag on a tree or a blob carries no history
      const s = git(["merge-base", "--is-ancestor", boundary, commit], cwd);
      if (s.status === 0) {
        out.push({ ref: r.remoteRef, why: `its history contains ${boundary.slice(0, 8)}` });
      } else if (s.status !== 1) {
        out.push({
          ref: r.remoteRef,
          why: `git could not tell whether its history contains ${boundary.slice(0, 8)} (exit ${s.status})`,
        });
      }
    }
  }
  return out;
}

/**
 * Rule 5: scripts/audit-public.mjs --push over the same ref lines git handed this hook. bun first,
 * because the audit imports server/src/secrets.ts and bun runs TypeScript as it is; node does from
 * 22.18 on. Returns 0 when the audit is clean, 1 when it found something, and 2 when it gave no
 * verdict: it said so itself (exit 2), it could not start, it was killed, or it ended with any other
 * code. A checkout without the script returns 0.
 */
export function runPushAudit(refText, remote, cwd = process.cwd()) {
  const script = join(cwd, ...AUDIT_SCRIPT.split("/"));
  if (!existsSync(script)) return 0;
  for (const runtime of ["bun", process.execPath]) {
    const r = spawnSync(runtime, [script, "--push", remote || "origin"], {
      cwd,
      input: refText,
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (r.error && r.error.code === "ENOENT" && runtime === "bun") continue;
    if (r.error) {
      console.error(`✗ audit:public could not start (${r.error.message}).`);
      return 2;
    }
    if (r.status === 0 || r.status === 1 || r.status === 2) return r.status;
    console.error(
      `✗ audit:public ended ${r.signal ? `on ${r.signal}` : `with exit ${r.status}`}, without a verdict.`,
    );
    return 2;
  }
  return 2;
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const refText = readStdin();
  const refs = parseRefLines(refText);
  if (refs.length === 0) return 0; // nothing to push (e.g. everything up to date)

  const pastBoundary = licenseRefusals(refs, licenseBoundaries());
  if (pastBoundary.length > 0) {
    console.error(
      [
        "",
        "✗ push refused: a pushed ref carries upstream's relicensing commit.",
        ...pastBoundary.map((r) => `    ${r.ref}: ${r.why}`),
        "",
        `  ${LICENSE_BOUNDARY.slice(0, 8)} moved upstream AgentHydra to the PolyForm Noncommercial license.`,
        "  AgentHydra Community is built from 3a65ba8e, the last MIT commit, and nothing from that",
        "  commit on may be pushed from this checkout. There is no override for this rule.",
        "",
      ].join("\n"),
    );
    return 1;
  }

  const { verdict, reason } = await lookupVisibility(remoteUrl);
  const override = (process.env.AGENTHYDRA_PUSH_PUBLIC || "").trim() === "1";
  const refList = refs.map(
    (r) =>
      `    ${r.isDelete ? "delete " : ""}${r.remoteRef}${r.isDelete ? "" : ` <- ${r.localRef} (${(r.localSha || "").slice(0, 7)})`}`,
  );

  if (verdict !== "private") {
    const lines = [
      "",
      PUBLIC_HEADING,
      "",
      verdict === "public"
        ? `  ${remoteName || "the remote"} (${remoteUrl}) is PUBLIC: ${reason}.`
        : `  ${remoteName || "the remote"} (${remoteUrl}) could not be proven private: ${reason}.`,
      "  A push here publishes to the internet and is a release for every source install.",
      "  Refs about to be pushed:",
      ...refList,
      "",
    ];
    if (override) {
      lines.push("  AGENTHYDRA_PUSH_PUBLIC=1 is set for this command: announced, proceeding.", "");
      console.error(lines.join("\n"));
    } else {
      lines.push(
        "  Refused. If the owner has decided this push goes out, re-run with:",
        "      AGENTHYDRA_PUSH_PUBLIC=1 git push ...",
        "  which prints this heading again and then pushes. Do not use --no-verify.",
        "",
      );
      console.error(lines.join("\n"));
      return 1;
    }
  }

  const audit = runPushAudit(refText, remoteName);
  if (audit !== 0 && audit !== 1) {
    console.error(
      [
        "",
        "✗ push refused: audit:public could not run (the reason is above), so nothing it checks is known",
        "  to be safe to publish. There is no override for this rule.",
        "",
      ].join("\n"),
    );
    return 1;
  }
  if (audit === 1) {
    console.error(
      [
        "",
        "✗ push refused: audit:public found something this push would publish (listed above).",
        "  Fix it, or, for a finding that is really fine, add its {rule, path, fp, reason} to",
        "  scripts/audit-public.allow.json. There is no override for this rule.",
        "",
      ].join("\n"),
    );
    return 1;
  }

  const releaseTags = refs.filter((r) => !r.isDelete && RELEASE_TAG.test(r.remoteRef || ""));
  if (releaseTags.length > 0) {
    const open = openTodoSections(join(process.cwd(), ...TODO_FILE.split("/")));
    if (open.length > 0) {
      console.error(
        [
          "",
          `✗ release refused: ${releaseTags.map((r) => r.remoteRef).join(", ")} would publish binaries while`,
          `  ${TODO_FILE} still has ${open.length} open section(s):`,
          ...open.map((h) => `    - ${h}`),
          "",
          "  Nothing pending ships past a release (owner directive, 2026-09-11). Finish the item and",
          "  delete its section, or the owner deletes it himself. There is no override for this rule.",
          "",
        ].join("\n"),
      );
      return 1;
    }
    const refused = await releaseRefusals(releaseTags);
    if (refused.length > 0) {
      console.error(
        [
          "",
          "✗ release refused:",
          ...refused.map((r) => `    ${r.ref}: ${r.why}`),
          "",
          "  scripts/release-notes.mjs builds the release page and decides what may ship; release.yml",
          "  runs the same check. There is no override for this rule.",
          "",
        ].join("\n"),
      );
      return 1;
    }
  }
  return 0;
}

/**
 * Rule 3: each release tag scripts/release-notes.mjs would refuse, with its reason. The CHANGELOG is
 * read from the tagged commit (the working tree's can differ). A checkout without the script, such as
 * a throwaway test repository, has nothing to check against and passes.
 */
async function releaseRefusals(releaseTags) {
  const script = join(process.cwd(), "scripts", "release-notes.mjs");
  if (!existsSync(script)) return [];
  const { refusal } = await import(pathToFileURL(script).href);
  const out = [];
  for (const r of releaseTags) {
    let changelog = "";
    try {
      changelog = execFileSync("git", ["show", `${r.localSha}:CHANGELOG.md`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      /* no CHANGELOG.md in that commit: refusal() says the version has no section */
    }
    const why = refusal(changelog, r.remoteRef.replace(/^refs\/tags\/v/, ""));
    if (why) out.push({ ref: r.remoteRef, why });
  }
  return out;
}

// Only run as a hook when executed directly; the exports above are importable by the tests.
const invokedDirectly =
  process.argv[1] && /check-public-push\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) {
  // exitCode rather than process.exit(): let the event loop drain so the lookup's socket is closed
  // before the process ends (see the `connection: close` note in lookupVisibility).
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`✗ pre-push guard crashed: ${err instanceof Error ? err.stack : err}`);
      process.exitCode = 1; // fail closed: a crashed guard must not read as a pass
    },
  );
}
