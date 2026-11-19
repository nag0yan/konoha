import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import app from "./app.ts";
import { initialize, pool, quoteIdentifier, schemaName } from "./db.ts";
import { appSpecSchema, checkAdditiveChange } from "../shared/spec.ts";
import { runSource } from "./code-runner.ts";
import { createVmRoutes, stopVms } from "./vm-apps.ts";
import type { AppFiles, RunningVm } from "./vm-runtime.ts";

process.env.GENERATOR = "template";
const suffix = randomUUID();
const emails = [`owner-${suffix}@example.com`, `member-${suffix}@example.com`, `outside-${suffix}@example.com`];
const appIds: string[] = [];

async function request(path: string, method = "GET", data?: unknown, cookie?: string): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(data === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

before(async () => { await initialize(); });
after(async () => {
  for (const id of appIds) {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName(id))} CASCADE`);
    await pool.query("DELETE FROM apps WHERE id=$1", [id]);
  }
  await pool.query("DELETE FROM users WHERE email = ANY($1::text[])", [emails]);
  await pool.end();
});

test("multi-user isolation, additive migration, and membership revocation", async () => {
  const cookies: string[] = [];
  for (const email of emails) {
    const registration = await request("/api/register", "POST", { email, password: "example-password-123" });
    assert.equal(registration.status, 201);
    const login = await request("/api/login", "POST", { email, password: "example-password-123" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    cookies.push(cookie);
  }
  const [owner, member, outsider] = cookies;
  assert.ok(owner && member && outsider);
  const unsupported = await request("/api/apps", "POST", { prompt: "品目を表にして、数量の合計を表示して", defaultVisibility: "private" }, owner);
  assert.equal(unsupported.status, 422);
  assert.match((await unsupported.json() as { error: string }).error, /「コード版」を選んで/);
  const created = await request("/api/apps", "POST", { prompt: "予約管理", defaultVisibility: "private" }, owner);
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { id: string };
  const id = createdBody.id;
  appIds.push(id);
  const invite = await request(`/api/apps/${id}/members`, "POST", { email: emails[1] }, owner);
  assert.equal(invite.status, 201);
  assert.equal((await request(`/api/apps/${id}/members`, "POST", { email: emails[2] }, member)).status, 403);
  const path = `/api/apps/${id}/records/reservations`;
  const shared = await request(path, "POST", { values: { customer: "A", date: "2026-01-01" }, visibility: "shared" }, member);
  const privateRecord = await request(path, "POST", { values: { customer: "B", date: "2026-01-02" }, visibility: "private" }, member);
  assert.equal(shared.status, 201);
  assert.equal(privateRecord.status, 201);
  const ownerPrivate = await request(path, "POST", { values: { customer: "C" }, visibility: "private" }, owner);
  assert.equal(ownerPrivate.status, 201);
  const ownerPrivateId = ((await ownerPrivate.json()) as { id: string }).id;
  const memberList = await request(path, "GET", undefined, member);
  assert.deepEqual(((await memberList.json()) as { customer: string }[]).map((row) => row.customer).sort(), ["A", "B"]);
  const ownerList = await request(path, "GET", undefined, owner);
  assert.equal(((await ownerList.json()) as unknown[]).length, 3);
  assert.equal((await request(path, "GET", undefined, outsider)).status, 403);
  assert.equal((await request(`${path}/${ownerPrivateId}`, "DELETE", undefined, member)).status, 404);
  assert.equal((await request(`${path}/${ownerPrivateId}`, "PATCH", { values: { customer: "stolen" }, visibility: "shared" }, member)).status, 404);
  assert.equal((await request(`/api/apps/${id}/change`, "POST", { prompt: "メモを追加" }, member)).status, 403);
  assert.equal((await request(`/api/apps/${id}/change`, "POST", { prompt: "予約にメモを追加" }, owner)).status, 200);
  const afterChange = await request(path, "GET", undefined, member);
  const rows = await afterChange.json() as { customer: string; note: string | null }[];
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.customer === "A")?.note, null);
  assert.equal((await request(path, "POST", { values: { customer: "D", note: "テスト" }, visibility: "shared" }, owner)).status, 201);
  const calendarChange = await request(`/api/apps/${id}/change`, "POST", { prompt: "日付をカレンダーで入力できるようにして" }, owner);
  assert.equal(calendarChange.status, 200);
  const calendarSpec = appSpecSchema.parse(((await calendarChange.json()) as { spec: unknown }).spec);
  const calendarFields = calendarSpec.entities.find((entity) => entity.name === "reservations")?.fields;
  assert.deepEqual(calendarFields?.map((field) => field.name), ["customer", "date", "note"]);
  assert.deepEqual(calendarFields?.find((field) => field.name === "date"), { name: "date", label: "日時", type: "text", widget: "date" });
  const calendarRows = await (await request(path, "GET", undefined, member)).json() as { customer: string; date: string | null }[];
  assert.equal(calendarRows.find((row) => row.customer === "A")?.date, "2026-01-01");
  assert.equal((await request(path, "POST", { values: { customer: "E", date: "2026-11-20" }, visibility: "shared" }, owner)).status, 201);
  const savedDates = await (await request(path, "GET", undefined, member)).json() as { customer: string; date: string | null }[];
  assert.equal(savedDates.find((row) => row.customer === "E")?.date, "2026-11-20");
  assert.equal((await request(path, "POST", { values: { unknown_field: "invalid" }, visibility: "shared" }, member)).status, 400);
  const membersResponse = await request(`/api/apps/${id}/members`, "GET", undefined, owner);
  const members = await membersResponse.json() as { id: string; role: string }[];
  const memberId = members.find((item) => item.role === "member")?.id;
  assert.ok(memberId);
  assert.equal((await request(`/api/apps/${id}/members/${memberId}`, "DELETE", undefined, owner)).status, 200);
  assert.equal((await request(path, "GET", undefined, member)).status, 403);
  assert.equal((await app.request("/api/apps", { method: "POST" })).status, 403);
});

test("schema validation rejects destructive changes and unsafe identifiers", () => {
  const before = appSpecSchema.parse({ title: "Test", entities: [{ name: "items", label: "Items", fields: [{ name: "name", label: "Name", type: "text" }] }] });
  const after = appSpecSchema.parse({ title: "Test", entities: [{ name: "items", label: "Items", fields: [{ name: "name", label: "Name", type: "number" }] }] });
  assert.throws(() => checkAdditiveChange(before, after));
  assert.throws(() => appSpecSchema.parse({ title: "Bad", entities: [{ name: "x;drop", label: "X", fields: [{ name: "name", label: "Name", type: "text" }] }] }));
});

test("code sandbox supports unrelated application data shapes", {
  skip: process.env.KONOHA_TEST_CODE !== "1",
}, async () => {
  const reservations = await runSource(`
    export const handle = ({ slots = [], booked = [] }) => slots.filter(slot => !booked.includes(slot));
    export const render = result => ({tag: "ul", children: result.map(slot => ({tag: "li", children: [slot]}))});
  `, { slots: ["09:00", "10:00"], booked: ["09:00"] });
  assert.deepEqual(reservations.result, ["10:00"]);
  const inventory = await runSource(`
    export const handle = ({ items = [] }) => ({ total: items.reduce((sum, item) => sum + item.quantity, 0) });
    export const render = result => "total: " + result.total;
  `, { items: [{ quantity: 3 }, { quantity: 1 }] });
  assert.deepEqual(inventory, { result: { total: 4 }, view: "total: 4" });
});

test("code revisions require owner approval and keep the active release unchanged until approval", {
  skip: process.env.KONOHA_TEST_CODE !== "1",
}, async () => {
  const cookies = [];
  for (const email of emails.slice(0, 2)) {
    const login = await request("/api/login", "POST", { email, password: "example-password-123" });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    cookies.push(cookie);
  }
  const [owner, member] = cookies;
  process.env.KONOHA_CODE_MODE = "fixture";
  try {
    const requirement = { prompt: "<b>Inventory</b>", sample: "{}" };
    assert.equal((await request("/api/code-apps", "POST", requirement)).status, 401);
    const memberCreation = await request("/api/code-apps", "POST", { prompt: "Member's own app", sample: "{}" }, member);
    assert.equal(memberCreation.status, 201);
    appIds.push((await memberCreation.json() as { id: string }).id);
    const created = await request("/api/code-apps", "POST", requirement, owner);
    assert.equal(created.status, 201);
    const { id, revision: first } = await created.json() as { id: string; revision: number };
    appIds.push(id);
    const apps = await (await request("/api/apps", "GET", undefined, owner)).json() as { id: string; spec: unknown }[];
    assert.deepEqual(apps.find((item) => item.id === id)?.spec, { title: requirement.prompt, entities: [] });
    const path = `/api/apps/${id}/code`;
    const state = await (await request(path, "GET", undefined, owner)).json() as { draft: { revision: number }; active: number | null };
    assert.equal(state.draft.revision, first);
    assert.equal(state.active, null);
    const invite = await request(`/api/apps/${id}/members`, "POST", { email: emails[1] }, owner);
    assert.equal(invite.status, 201);
    const make = async (prompt: string) => {
      const response = await request(path, "POST", { prompt, sample: '{"items":[]}' }, owner);
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
      return (await response.json() as { revision: number }).revision;
    };
    assert.equal((await request(path, "POST", { prompt: "not allowed", sample: "{}" }, member)).status, 403);
    assert.equal((await request(`${path}/preview/${first}`, "GET", undefined, member)).status, 403);
    assert.equal((await request(`${path}/release`, "GET", undefined, member)).status, 404);
    const preview = await request(`${path}/preview/${first}`, "GET", undefined, owner);
    assert.match(preview.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.match(await preview.text(), /<h1>&lt;b&gt;Inventory&lt;\/b&gt;<\/h1>/);
    assert.equal((await request(`${path}/${first}/approve`, "POST", {}, member)).status, 403);
    assert.equal((await request(`${path}/${first}/approve`, "POST", {}, owner)).status, 200);
    const second = await make("New revision");
    const active = await request(`${path}/release?format=html`, "GET", undefined, member);
    assert.match(await active.text(), /<h1>&lt;b&gt;Inventory/);
    const result = await request(`${path}/release/run`, "POST", { sample: '{"services":[]}' }, member);
    assert.deepEqual(await result.json(), { keys: ["services"] });
    assert.equal((await request(`${path}/${second}/approve`, "POST", {}, owner)).status, 200);
    assert.match(await (await request(`${path}/release?format=html`, "GET", undefined, member)).text(), /<h1>New revision<\/h1>/);
  } finally {
    delete process.env.KONOHA_CODE_MODE;
  }
});

test("VM app edits keep the old version available until the candidate boots", async (t) => {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = ANY($1) ORDER BY email", [emails.slice(0, 2)]);
  const [owner, outsider] = rows;
  assert.ok(owner && outsider);
  const sample = (title: string): AppFiles => [{ path: "server.mjs", content: `console.log(${JSON.stringify(title)});` }];
  const old = sample("original");
  const broken = sample("broken");
  const updated = sample("updated");
  const releaseBoot = Promise.withResolvers<void>();
  const stopped: string[] = [];
  const routes = new Hono<{ Variables: { userId: string; sessionHash: string } }>();
  routes.use("*", async (c, next) => {
    c.set("userId", c.req.header("x-test-user") ?? owner.id);
    c.set("sessionHash", "test");
    await next();
  });
  routes.route("/vm", createVmRoutes(async (prompt, _repair, base) => {
    assert.deepEqual(base, old);
    return prompt === "fail" ? broken : updated;
  }, async (files): Promise<RunningVm> => {
    if (files[0]?.content === broken[0]?.content) throw new Error("Candidate boot failed");
    const name = files[0]?.content === old[0]?.content ? "original" : "updated";
    if (name === "updated") await releaseBoot.promise;
    const exit = Promise.withResolvers<void>();
    return { socket: name, exited: exit.promise, stop: () => { stopped.push(name); exit.resolve(); } };
  }));
  const id = randomUUID();
  const send = (path: string, method = "GET", data?: object, user = owner.id) => routes.request(`/vm${path}`, {
    method, headers: { "x-test-user": user, "content-type": "application/json" }, ...(data && { body: JSON.stringify(data) }),
  });
  async function waitFor(predicate: (entry: { status: string; revisionStatus: string | null; revision: number; revisionError: string | null }) => boolean) {
    for (let i = 0; i < 100; i++) {
      const entries = await (await send("")).json();
      if (entries[0] && predicate(entries[0])) return;
      await delay(10);
    }
    assert.fail("App state did not reach expected value");
  }
  await pool.query("INSERT INTO vm_apps (id,owner_id,title,files) VALUES ($1,$2,'test VM',$3)", [id, owner.id, JSON.stringify(old)]);
  t.mock.timers.enable({ apis: ["Date"] });
  try {
    assert.equal((await send(`/${id}/start`, "POST", {})).status, 202);
    await waitFor((entry) => entry.status === "ready");
    assert.equal((await send(`/${id}/revise`, "POST", { prompt: "fail" }, outsider.id)).status, 404);
    assert.equal((await send(`/${id}/revise`, "POST", { prompt: "fail" })).status, 202);
    await waitFor((entry) => entry.revisionError !== null && entry.revisionStatus === null && entry.revision === 1 && entry.status === "ready");
    assert.deepEqual((await pool.query("SELECT files FROM vm_apps WHERE id=$1", [id])).rows[0]?.files, old);
    assert.deepEqual(stopped, []);
    t.mock.timers.tick(15001);
    assert.equal((await send(`/${id}/revise`, "POST", { prompt: "improve" })).status, 202);
    await waitFor((entry) => entry.revisionStatus === "starting" && entry.status === "ready");
    assert.equal((await send(`/${id}/open`)).status, 302);
    assert.deepEqual(stopped, []);
    releaseBoot.resolve();
    await waitFor((entry) => entry.revision === 2 && entry.status === "ready" && entry.revisionStatus === null);
    assert.deepEqual((await pool.query("SELECT files FROM vm_apps WHERE id=$1", [id])).rows[0]?.files, updated);
    assert.deepEqual(stopped, ["original"]);
    assert.equal((await send(`/${id}/open`)).status, 302);
  } finally {
    releaseBoot.resolve();
    stopVms();
    await pool.query("DELETE FROM vm_apps WHERE id=$1", [id]);
    t.mock.timers.reset();
  }
});
