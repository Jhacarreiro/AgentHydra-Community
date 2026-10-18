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
 *  4. No ref may carry upstream's relicensing commit. AgentHydra Community starts from the tree of
 *     3a65ba8e, the last commit LunarWerxs/AgentHydra published under MIT; the very next one,
 *     aee9dfc4, moved AgentHydra to the PolyForm Noncommercial license, and nothing from it on may be
 *     published from this checkout. A merge or rebase onto upstream's main would bring it in without
 *     a single changed file saying so, so the history of every pushed ref is checked, on every push
 *     to any remote. scripts/audit-public.config.json may name a further boundary commit; it can only
 *     add to this one. No override.
 *
 *  5. scripts/audit-public.mjs runs over what the push carries (its --push mode: the commits the
 *     remote does not have yet, after the import commit, which it checks first): tokens and keys,
 *     credential files, private addresses, email addresses, home paths, upstream's hosts and private
 *     repositories, binaries with no provenance, and commit emails that are not noreply. It runs for
 *     every remote, private ones too: this repository is public by design, a private repository can
 *     be made public later, and "private" here can also mean "does not exist yet". A finding that is
 *     fine goes in scripts/audit-public.allow.json; there is no override. An audit that gives no
 *     verdict (it cannot load, start or finish, or the import commit is missing, as in a shallow
 *     clone, or is not a root commit with upstream's tree and the only root of every pushed commit's
 *     history) refuses the push as well, and says so rather than calling it a finding. A checkout
 *     without the script has nothing to audit with and passes, as for rule 3.
 *
 *  6. No tag may point at upstream's work. Every commit up to 3a65ba8e is upstream's, and the tags
 *     on them (v0.1.0 to v2.0.4, orchestrator-v1-final) are upstream's releases, which a
 *     `git push --tags` from a clone that also has upstream's history would publish as this
 *     repository's. A v2.0.x one would even pass rule 3 and start release.yml. The import commit at
 *     the root of this repository's history is upstream's work too: its tree is 3a65ba8e's,
 *     unchanged, upstream's own release.yml included, and a tag runs the workflow of the commit it
 *     points to. So a tag is refused when its commit is 3a65ba8e or in its history, or when its tree
 *     is 3a65ba8e's tree. The audit config's upstreamBase and baseTree may name a further commit and
 *     tree, never take these away; its `base`, the import commit, is not what this rule reads. A
 *     clone without 3a65ba8e (every clone of this repository) cannot look for upstream's commits,
 *     so only the tree is checked there; one of upstream's older tags fetched into such a clone is
 *     refused by rule 7, since its history has a root of its own. No override.
 *
 *  7. No ref may carry upstream's history, or any history but this repository's. This
 *     repository's history starts at the import commit, which has no parent: upstream's history up
 *     to 3a65ba8e stays in upstream's repository, and this one deliberately does not publish it. On
 *     every remote, a ref is refused when its history shares a commit with 3a65ba8e's (3a65ba8e
 *     itself or any commit before it; the audit config's upstreamBase may name a further commit),
 *     and when it has a root commit other than the import commit (the audit config's base, or
 *     IMPORT_COMMIT in a checkout without that config). The second check needs none of upstream's
 *     objects: one of upstream's older tags fetched on its own, without 3a65ba8e, brings a root of
 *     its own, and so does a merge of any unrelated history. A clone without the import commit
 *     holds none of this repository's history (a throwaway test repository, say), and there only
 *     the first check runs. A shallow clone's cut-off commits look like roots, and are refused as
 *     such: what lies behind them cannot be told. No override.
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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PUBLIC_HEADING = "# WARNING: THIS REPOSITORY IS **PUBLIC**";
const LOOKUP_TIMEOUT_MS = 5000;
const ZERO_SHA = /^0+$/;
const RELEASE_TAG = /^refs\/tags\/v\d+\.\d+\.\d+/;
const TODO_FILE = "docs/todo/TODO.md";
// Rule 4: upstream's relicensing commit, the one that moved AgentHydra from MIT to PolyForm Noncommercial 1.0.0.
export const LICENSE_BOUNDARY = "aee9dfc4f7dd0228d8e1740be90b646b30204f37";
// Rules 6 and 7: upstream's last MIT commit. Its history is upstream's; this repository does not carry it.
export const UPSTREAM_BASE = "3a65ba8e6497c16732f627fc8934723839c82fdd";
// Rule 6: that commit's tree, which the import commit at the root of this repository's history has.
export const UPSTREAM_TREE = "d6eda7b9e375d15e916c7a001099fa96051d6cc2";
// Rule 7: the import commit, the one root of this repository's history. The audit config's base names
// it; this is the value for a checkout without that config.
export const IMPORT_COMMIT = "c81335b7e90a85880cffbb54e51743a459cc7172";
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

/** The audit config's `key` when it is a full object id (in lower case), or "" when there is none. */
function configuredId(key, cwd) {
  try {
    const cfg = JSON.parse(readFileSync(join(cwd, ...AUDIT_CONFIG.split("/")), "utf8"));
    const id = String(cfg?.[key] || "").toLowerCase();
    return /^[0-9a-f]{40}$/.test(id) ? id : "";
  } catch {
    return ""; // no config, or an unreadable one
  }
}

/**
 * `constant`, plus the audit config's `key` when it names another full object id. The config can
 * add to a rule, never take its constant away; no config, or an unreadable one, leaves the constant.
 */
function withConfigured(constant, key, cwd) {
  const extra = configuredId(key, cwd);
  return extra && extra !== constant ? [constant, extra] : [constant];
}

/** Rule 4's commits: LICENSE_BOUNDARY, plus the audit config's licenseBoundary when it names another. */
export function licenseBoundaries(cwd = process.cwd()) {
  return withConfigured(LICENSE_BOUNDARY, "licenseBoundary", cwd);
}

/** Rules 6 and 7's commits: UPSTREAM_BASE, plus the audit config's upstreamBase when it names one. */
export function upstreamBases(cwd = process.cwd()) {
  return withConfigured(UPSTREAM_BASE, "upstreamBase", cwd);
}

/** Rule 6's trees: UPSTREAM_TREE, plus the audit config's baseTree when it names another. */
export function upstreamTrees(cwd = process.cwd()) {
  return withConfigured(UPSTREAM_TREE, "baseTree", cwd);
}

/** Rule 7's root: the audit config's base (the import commit), or IMPORT_COMMIT without one. */
export function importCommit(cwd = process.cwd()) {
  return configuredId("base", cwd) || IMPORT_COMMIT;
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The commit a pushed sha names (an annotated tag peeled), or "" for a tree, a blob or nothing. */
function peeledCommit(sha, cwd) {
  return (git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], cwd).stdout || "").trim();
}

/** Whether this clone has `sha` as a commit. */
function hasCommit(sha, cwd) {
  return git(["cat-file", "-e", `${sha}^{commit}`], cwd).status === 0;
}

/** The commits a shallow clone cut off from their parents, which git shows as roots; none otherwise. */
function shallowCommits(cwd) {
  if ((git(["rev-parse", "--is-shallow-repository"], cwd).stdout || "").trim() !== "true") {
    return new Set();
  }
  const file = (git(["rev-parse", "--git-path", "shallow"], cwd).stdout || "").trim();
  try {
    return new Set(readFileSync(resolve(cwd, file), "utf8").split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Rule 4: each pushed ref whose history holds one of `boundaries`, with the reason. A boundary commit
 * this clone does not have cannot be in any of its refs' history, so it is skipped; a git answer
 * that is neither yes nor no refuses (fail closed).
 */
export function licenseRefusals(refs, boundaries, cwd = process.cwd()) {
  const out = [];
  for (const boundary of boundaries) {
    if (!hasCommit(boundary, cwd)) continue;
    for (const r of refs) {
      if (r.isDelete) continue;
      const commit = peeledCommit(r.localSha, cwd);
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
 * Rule 6: each pushed tag that points at upstream's work, with the reason: a commit that is one of
 * `bases` or in its history (upstream's own tags), or a commit whose tree is one of `trees` (the
 * import commit, whose tree is upstream's). A base this clone does not have is in no tag's history,
 * so then only the trees are checked; a git answer that is neither yes nor no refuses (fail closed).
 */
export function upstreamTagRefusals(refs, { bases = [], trees = [] } = {}, cwd = process.cwd()) {
  const present = bases.filter((base) => hasCommit(base, cwd));
  const out = [];
  for (const r of refs) {
    if (r.isDelete || !(r.remoteRef || "").startsWith("refs/tags/")) continue;
    const commit = peeledCommit(r.localSha, cwd);
    if (!commit) continue; // a tag on a tree or a blob points at no commit
    const refusal = upstreamTagReason(commit, present, trees, cwd);
    if (refusal) out.push({ ref: r.remoteRef, why: refusal });
  }
  return out;
}

function upstreamTagReason(commit, bases, trees, cwd) {
  const at = commit.slice(0, 8);
  for (const base of bases) {
    const s = git(["merge-base", "--is-ancestor", commit, base], cwd);
    if (s.status === 0) return `it points at ${at}, in the history of ${base.slice(0, 8)}`;
    if (s.status !== 1) {
      return `git could not tell whether ${at} is in the history of ${base.slice(0, 8)} (exit ${s.status})`;
    }
  }
  const peeled = git(["rev-parse", "--verify", "--quiet", `${commit}^{tree}`], cwd);
  const tree = (peeled.stdout || "").trim();
  if (!tree) return `git could not read the tree of ${at}`;
  if (trees.includes(tree)) return `it points at ${at}, whose tree is upstream's ${tree.slice(0, 8)}`;
  return null;
}

/**
 * Rule 7: each pushed ref whose history shares a commit with one of `bases` (the base itself, or
 * any commit before it), with the reason. `git merge-base` finds the shared commit; a base this clone
 * does not have shares nothing with any of its refs, so it is skipped, and a git answer that is
 * neither yes nor no refuses (fail closed).
 */
export function upstreamHistoryRefusals(refs, bases, cwd = process.cwd()) {
  const out = [];
  for (const base of bases) {
    if (!hasCommit(base, cwd)) continue;
    const of = base.slice(0, 8);
    for (const r of refs) {
      if (r.isDelete) continue;
      const commit = peeledCommit(r.localSha, cwd);
      if (!commit) continue; // a tag on a tree or a blob carries no history
      const s = git(["merge-base", base, commit], cwd);
      const shared = (s.stdout || "").trim().split("\n")[0];
      if (s.status === 0 && shared) {
        out.push({
          ref: r.remoteRef,
          why:
            shared === base
              ? `its history contains ${of}`
              : `its history contains ${shared.slice(0, 8)}, in the history of ${of}`,
        });
      } else if (s.status !== 1) {
        out.push({
          ref: r.remoteRef,
          why: `git could not tell whether its history shares a commit with ${of} (exit ${s.status})`,
        });
      }
    }
  }
  return out;
}

/**
 * Rule 7's other half: each pushed ref whose history has a root commit other than `root`, the
 * import commit, with the reason. It needs none of upstream's objects. A clone without `root` holds
 * none of this repository's history, so nothing is checked there; a commit a shallow clone cut off
 * from its parents looks like a root, and is refused as one whose history cannot be told. A git
 * answer that is not a list refuses (fail closed).
 */
export function foreignRootRefusals(refs, root, cwd = process.cwd()) {
  const own = peeledCommit(root, cwd);
  if (!own) return [];
  const cut = shallowCommits(cwd);
  const out = [];
  for (const r of refs) {
    if (r.isDelete) continue;
    const commit = peeledCommit(r.localSha, cwd);
    if (!commit) continue; // a tag on a tree or a blob carries no history
    const s = git(["rev-list", "--max-parents=0", commit], cwd);
    if (s.status !== 0) {
      out.push({ ref: r.remoteRef, why: `git could not list the roots of its history (exit ${s.status})` });
      continue;
    }
    const others = (s.stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((c) => c && c !== own);
    if (others.length === 0) continue;
    const shallow = others.find((c) => cut.has(c));
    const more = others.length > 1 ? ` (and ${others.length - 1} more)` : "";
    out.push({
      ref: r.remoteRef,
      why: shallow
        ? `this shallow clone cuts its history off at ${shallow.slice(0, 8)}, so whether it starts at the import commit ${own.slice(0, 8)} cannot be told (git fetch --unshallow)`
        : `its history has the root commit ${others[0].slice(0, 8)}${more}, not only the import commit ${own.slice(0, 8)}`,
    });
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
        "  AgentHydra Community starts from the tree of 3a65ba8e, the last MIT commit, and nothing",
        "  from aee9dfc4 on may be pushed from this checkout. There is no override for this rule.",
        "",
      ].join("\n"),
    );
    return 1;
  }

  const upstream = { bases: upstreamBases(), trees: upstreamTrees() };
  const upstreamTags = upstreamTagRefusals(refs, upstream);
  if (upstreamTags.length > 0) {
    console.error(
      [
        "",
        "✗ push refused: a pushed tag is one of upstream's, on its history or on its tree.",
        ...upstreamTags.map((r) => `    ${r.ref}: ${r.why}`),
        "",
        "  Upstream's commits and their tags are upstream's own releases. The import commit at the root",
        "  of this history is upstream's too: its tree is 3a65ba8e's, unchanged, upstream's release.yml",
        "  included. Push the branches without them (git push <remote> <branch>, not --tags or --mirror),",
        "  and tag this repository's own releases on its own commits. There is no override for this rule.",
        "",
      ].join("\n"),
    );
    return 1;
  }

  const upstreamHistory = upstreamHistoryRefusals(refs, upstream.bases);
  const caught = new Set(upstreamHistory.map((r) => r.ref));
  const otherRoots = foreignRootRefusals(refs, importCommit()).filter((r) => !caught.has(r.ref));
  if (upstreamHistory.length > 0 || otherRoots.length > 0) {
    console.error(
      [
        "",
        "✗ push refused: a pushed ref carries upstream's history, or history from another root.",
        ...[...upstreamHistory, ...otherRoots].map((r) => `    ${r.ref}: ${r.why}`),
        "",
        "  This repository's history starts at the import commit, which has no parent: upstream's",
        "  history up to 3a65ba8e stays in upstream's repository and is not published from here, and",
        "  neither is any history with a root of its own. Push only branches built on this repository's",
        "  own history. There is no override for this rule.",
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
