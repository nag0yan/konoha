import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelSpec } from "./generator.ts";

const json = JSON.stringify({
  title: "予約",
  entities: [{ name: "reservations", label: "予約", fields: [{ name: "name", label: "名前", type: "text" }] }],
});

test("accepts JSON and JSON fenced by a model", () => {
  assert.equal(parseModelSpec(json).title, "予約");
  assert.equal(parseModelSpec(`\`\`\`json\n${json}\n\`\`\``).entities[0]?.name, "reservations");
});

test("rejects extra text and invalid definitions", () => {
  assert.throws(() => parseModelSpec(`Result:\n${json}`));
  assert.throws(() => parseModelSpec('{"title":"broken","entities":[]}'));
});

test("keeps calendar widget metadata on text fields and rejects it on other field types", () => {
  const calendar = {
    title: "予約",
    entities: [{ name: "reservations", label: "予約", fields: [{ name: "date", label: "日付", type: "text", widget: "date" }] }],
  };
  assert.deepEqual(parseModelSpec(JSON.stringify(calendar)), calendar);
  calendar.entities[0]!.fields[0]!.type = "boolean";
  assert.throws(() => parseModelSpec(JSON.stringify(calendar)));
});
