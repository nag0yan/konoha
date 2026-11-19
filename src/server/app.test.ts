import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import app from "./app.ts";
import { initialize, pool } from "./db.ts";
import { createVmRoutes, stopVms } from "./vm-apps.ts";
import type { AppFiles, RunningVm } from "./vm-runtime.ts";

const suffix = randomUUID();
const revisionEmails = [`owner-${suffix}@example.com`, `visitor-${suffix}@example.com`];
const authEmail = `login-${suffix}@example.com`;

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
  await pool.query("DELETE FROM users WHERE email = ANY($1::text[])", [[authEmail, ...revisionEmails]]);
  await pool.end();
});

test("authenticated users can access VM apps but not the retired API routes", async () => {
  const password = "test-password-only";
  assert.equal((await request("/api/register", "POST", { email: authEmail, password })).status, 201);
  assert.equal((await request("/api/vm-apps")).status, 401);
  const login = await request("/api/login", "POST", { email: authEmail, password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const me = await request("/api/me", "GET", undefined, cookie);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).email, authEmail);
  const apps = await request("/api/vm-apps", "GET", undefined, cookie);
  assert.equal(apps.status, 200);
  assert.deepEqual(await apps.json(), []);
  assert.equal((await request("/api/apps", "GET", undefined, cookie)).status, 404);
  assert.equal((await request("/api/code-apps", "POST", {}, cookie)).status, 404);
  assert.equal((await request(`/api/apps/${randomUUID()}/code`, "GET", undefined, cookie)).status, 404);
  assert.equal((await request("/api/logout", "POST", undefined, cookie)).status, 200);
  assert.equal((await request("/api/vm-apps", "GET", undefined, cookie)).status, 401);
});

test("VM app edits keep the old version available until the candidate boots", async (t) => {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO users (id,email,password_hash) VALUES ($1,$2,''),($3,$4,'') RETURNING id",
    [randomUUID(), revisionEmails[0], randomUUID(), revisionEmails[1]],
  );
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
