import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildInjection, isContinuation, loadPersonas, pick } from "../router.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const { personas } = loadPersonas(fixtures);
const UI = "alpha-ui";
const BACKEND = "beta-backend";
const FLOOR = "floor-quick";
const COORD = "coord-big";

const scores = ({ big = 0, domains = {} } = {}) => ({ big, quick: 0, domains: { [UI]: 0, [BACKEND]: 0, ...domains } });

test("fixtures load as four managers with no skipped folders", () => {
  const loaded = loadPersonas(fixtures);
  assert.deepEqual(loaded.personas.map((p) => p.slug), [UI, BACKEND, COORD, FLOOR]);
  assert.deepEqual(loaded.skipped, []);
});

test("big at 0.7 goes to the coordinator, below it does not", () => {
  assert.equal(pick(scores({ big: 0.7, domains: { [BACKEND]: 0.9 } }), null, personas).slug, COORD);
  assert.equal(pick(scores({ big: 0.69, domains: { [BACKEND]: 0.9 } }), null, personas).slug, BACKEND);
});

test("a domain at 0.6 wins with no current manager, and below 0.6 the floor takes it", () => {
  assert.equal(pick(scores({ domains: { [UI]: 0.6 } }), null, personas).slug, UI);
  assert.equal(pick(scores({ domains: { [UI]: 0.59 } }), null, personas).slug, FLOOR);
});

test("a current domain manager at 0.45 holds unless the best is 0.25 ahead", () => {
  const current = UI;
  assert.equal(pick(scores({ domains: { [UI]: 0.5, [BACKEND]: 0.7 } }), current, personas).slug, UI);
  assert.equal(pick(scores({ domains: { [UI]: 0.5, [BACKEND]: 0.75 } }), current, personas).slug, BACKEND);
});

test("a current domain manager under 0.45 gives way to a 0.6 domain", () => {
  assert.equal(pick(scores({ domains: { [UI]: 0.4, [BACKEND]: 0.6 } }), UI, personas).slug, BACKEND);
});

test("no flapping: the manager that holds stays while the other is not clearly ahead", () => {
  let current = BACKEND;
  const rounds = [
    { [BACKEND]: 0.7, [UI]: 0.6 },
    { [BACKEND]: 0.65, [UI]: 0.6 },
    { [BACKEND]: 0.7, [UI]: 0.65 },
  ];
  for (const domains of rounds) {
    current = pick(scores({ domains }), current, personas).slug;
    assert.equal(current, BACKEND);
  }
});

test("no domain at 0.6 keeps the current manager, and a fresh session gets the floor", () => {
  assert.equal(pick(scores({ domains: { [UI]: 0.5, [BACKEND]: 0.59 } }), UI, personas).slug, UI);
  assert.equal(pick(scores({ domains: { [UI]: 0.3 } }), FLOOR, personas).slug, FLOOR);
  assert.equal(pick(scores({ domains: { [UI]: 0.3 } }), null, personas).slug, FLOOR);
});

test("a continuation word keeps the conversation going", () => {
  for (const prompt of ["continue", "go", "yes", "do it", "keep going", "ok thanks", "yes please"]) {
    assert.equal(isContinuation(prompt), true, prompt);
  }
});

test("a short message with a new subject is not a continuation", () => {
  for (const prompt of ["the API is down", "fix the button", "api", "check the login page now"]) {
    assert.equal(isContinuation(prompt), false, prompt);
  }
});

test("a short reminder names the manager and the brief path", () => {
  const ada = personas.find((p) => p.slug === UI);
  const line = buildInjection(ada, personas, { full: false });
  assert.equal(line, `Manager Hydra: still Ada (Interface Design Lead). Brief: ${ada.briefPath}.`);
});

test("a full injection carries the brief, absolute playbook paths and a roster without the manager itself", () => {
  const ada = personas.find((p) => p.slug === UI);
  const text = buildInjection(ada, personas, { full: true, briefText: "FIXTURE-BRIEF-ALPHA body", reason: "assigned" });
  assert.match(text, /FIXTURE-BRIEF-ALPHA body/);
  assert.ok(text.includes(path.join(ada.dir, "playbook", "01-layout.md")));
  assert.match(text, /Ben, Backend Engineer \(domain, slug beta-backend\)/);
  assert.ok(!text.includes("slug alpha-ui"));
});

test("a folder without a valid persona.json is ignored, an invalid one is named as skipped", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "managers-pick-"));
  try {
    mkdirSync(path.join(root, "no-persona"));
    writeFileSync(path.join(root, "no-persona", "brief.md"), "x");
    mkdirSync(path.join(root, "broken"));
    writeFileSync(path.join(root, "broken", "persona.json"), "{ not json");
    mkdirSync(path.join(root, "bad-role"));
    writeFileSync(path.join(root, "bad-role", "persona.json"), JSON.stringify({ slug: "bad-role", name: "B", title: "T", role: "boss", brief: "brief.md" }));
    writeFileSync(path.join(root, "bad-role", "brief.md"), "x");
    const loaded = loadPersonas(root);
    assert.deepEqual(loaded.personas, []);
    assert.deepEqual(loaded.skipped.map((s) => s.folder), ["bad-role", "broken"]);
    assert.match(loaded.skipped[1].reason, /persona\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
