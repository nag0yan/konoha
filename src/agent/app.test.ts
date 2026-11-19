import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentApp } from "./app.ts";
import type { AppSpec } from "../shared/spec.ts";

const spec: AppSpec = {
  title: "Test",
  entities: [{ name: "items", label: "Items", fields: [{ name: "name", label: "Name", type: "text" }] }],
};

test("AgentCore HTTP contract validates requests and returns a definition", async () => {
  const app = createAgentApp(async () => spec);
  assert.deepEqual(await (await app.request("/ping")).json(), { status: "Healthy" });
  const result = await app.request("/invocations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "make an app" }) });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), spec);
  assert.equal((await app.request("/invocations", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
});
