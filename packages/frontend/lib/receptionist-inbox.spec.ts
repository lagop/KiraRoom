/**
 * Conversaciones: the list's query, its pages and the attention labels.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/receptionist-inbox.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  attentionKey,
  channelFrom,
  inboxPages,
  inboxQuery,
  viewFrom,
  withConversation,
  type InboxConversation,
  type InboxListItem,
} from "./receptionist-inbox";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

check("no filters, no query", inboxQuery() === "" && inboxQuery({ view: "all", page: 1, q: "  " }) === "");
check(
  "the filters the API reads",
  inboxQuery({ view: "attention", channel: "whatsapp", q: " tinte ", page: 2 }) === "?view=attention&channel=whatsapp&q=tinte&page=2",
  inboxQuery({ view: "attention", channel: "whatsapp", q: " tinte ", page: 2 }),
);
check("the search is encoded", inboxQuery({ q: "uñas & pies" }) === "?q=u%C3%B1as+%26+pies");

check("one page when empty", inboxPages({ total: 0, pageSize: 30 }) === 1);
check("31 conversations are two pages", inboxPages({ total: 31, pageSize: 30 }) === 2);

check("not told: no label", attentionKey(null) === null);
check("asked for a person", attentionKey({ reason: "client_asked_person", at: "x" }) === "receptionistInbox.attention.client_asked_person");
check("could not answer", attentionKey({ reason: "assistant_could_not_answer", at: "x" }) === "receptionistInbox.attention.assistant_could_not_answer");

check("an unknown view is all", viewFrom("deleted") === "all" && viewFrom(null) === "all" && viewFrom("paused") === "paused");
check("an unknown channel is every channel", channelFrom("sms") === "" && channelFrom("telegram") === "telegram");

const item = (id: string): InboxListItem => ({
  id,
  channel: "web",
  name: "Ana",
  clientId: null,
  lastActivityAt: "2026-11-04T10:00:00Z",
  totalMessages: 2,
  lastMessage: null,
  attention: { reason: "client_asked_person", at: "2026-11-04T10:00:00Z" },
  paused: false,
});
const after: InboxConversation = { ...item("b"), createdAt: "2026-11-04T09:00:00Z", paused: true, attention: null, messages: [] };
const list = withConversation([item("a"), item("b")], after);
check("an action updates its row only", list[0].paused === false && list[0].attention !== null && list[1].paused && list[1].attention === null, list);

const messages = ["es", "en"].map((lang) => JSON.parse(fs.readFileSync(path.join(__dirname, "../messages", `${lang}.json`), "utf8").replace(/^﻿/, "")));
const keys = (o: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
const es = keys(messages[0].receptionistInbox ?? {}).sort();
const en = keys(messages[1].receptionistInbox ?? {}).sort();
check("Spanish first", messages[0].receptionistInbox?.title === "Conversaciones");
check("the same keys in es.json and en.json", es.length > 0 && es.join() === en.join(), { es, en });
check(
  "the chat's privacy line and Nueva conversación in both",
  ["noHealthData", "privacy", "newConversation"].every((k) => messages.every((m) => typeof m.publicChat?.[k] === "string")),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
