import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerText } from "../hook.mjs";

// A1-F2: the per-message additions are scored on the owner's own words, never on what AgentHydra wrapped around them.
const NL = String.fromCharCode(10);
const lines = (...parts) => parts.join(NL);

test("a plain message is the owner's words as typed", () => {
  assert.equal(ownerText("  fix the invented button  "), "fix the invented button");
});

test("a handoff keeps the owner's message and the messages the earlier session missed, not the note or document", () => {
  const prompt = lines(
    "where are we",
    "",
    "---",
    "An earlier session already worked on this task on another account and wound down before its usage limit. Continue from its handoff below.",
    "",
    "The orchestrator also sent these messages, which the earlier session did not get to:",
    "- check the pricing page",
    "- and the invented footer",
    "",
    "--- HANDOFF ---",
    "a long document about pricing tables and plans",
  );
  assert.equal(ownerText(prompt), lines("where are we", "", "check the pricing page", "", "and the invented footer"));
});

test("the Send now and urgent prefaces go, the message stays", () => {
  assert.equal(ownerText(lines("[Sent now: the user stopped your previous turn mid-step. Act on it first.]", "fix it")), "fix it");
  assert.equal(
    ownerText(
      lines("AgentHydra stopped your previous turn mid-step to deliver this message from the orchestrator. Act on it.", "", "ship it"),
    ),
    "ship it",
  );
});

test("task notifications and reminders queued with the message are not the owner's words", () => {
  const prompt = lines("look at the logs", "<task-notification>", "<status>completed</status>", "</task-notification>", "<system-reminder>x</system-reminder>");
  assert.equal(ownerText(prompt), "look at the logs");
  assert.equal(ownerText("<task-notification>done</task-notification>"), "");
});
