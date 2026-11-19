import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z, ZodError } from "zod";
import { pool, applySpec, quoteIdentifier, schemaName } from "./db.ts";
import { generateSpec, UnsupportedTemplateRequest } from "./generator.ts";
import code, { codeCreation, codeMode } from "./code-app.ts";
import { createVmRoutes } from "./vm-apps.ts";
import { appSpecSchema, RecordValidationError, validateRecord, type AppSpec, type Entity } from "../shared/spec.ts";

const scrypt = promisify(scryptCallback);
type Env = { Variables: { userId: string; sessionHash: string } };
const app = new Hono<Env>();
const credentialsSchema = z.object({ email: z.email().max(254).transform((value) => value.toLowerCase()), password: z.string().min(12).max(200) });
const promptSchema = z.object({ prompt: z.string().min(1).max(4000) });
const visibilitySchema = z.enum(["shared", "private"]);
const storedSpecSchema = z.union([appSpecSchema, z.object({ title: z.string().min(1).max(100), entities: z.tuple([]) })]);

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) throw new Error("Invalid stored password hash");
  const candidate = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function userId(token: string | undefined): Promise<string | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()", [hashToken(token)],
  );
  return result.rows[0]?.user_id ?? null;
}

type AppAccess = { id: string; owner_id: string; spec: AppSpec; version: number; default_visibility: "shared" | "private"; role: "owner" | "member" };
async function access(appId: string, user: string): Promise<AppAccess | null> {
  if (!z.uuid().safeParse(appId).success) return null;
  const result = await pool.query<AppAccess>(
    "SELECT a.*, m.role FROM apps a JOIN members m ON m.app_id = a.id WHERE a.id = $1 AND m.user_id = $2",
    [appId, user],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, spec: storedSpecSchema.parse(row.spec) };
}

function getEntity(spec: AppSpec, name: string): Entity | undefined {
  return spec.entities.find((entity) => entity.name === name);
}

app.onError((error, c) => {
  if (error instanceof UnsupportedTemplateRequest) return c.json({ error: error.message }, 422);
  if (error instanceof ZodError || error instanceof SyntaxError || error instanceof RecordValidationError) return c.json({ error: "入力内容が正しくありません" }, 400);
  console.error(error);
  return c.json({ error: "処理に失敗しました。サーバーログを確認してください。" }, 500);
});

app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const allowed = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";
    if (origin !== allowed) return c.json({ error: "Invalid request origin" }, 403);
  }
  await next();
});

app.post("/api/register", async (c) => {
  const input = credentialsSchema.parse(await c.req.json());
  const id = randomUUID();
  const result = await pool.query(
    "INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id",
    [id, input.email, await passwordHash(input.password)],
  );
  if (!result.rowCount) return c.json({ error: "このメールアドレスは登録済みです" }, 409);
  return c.json({ ok: true }, 201);
});

app.post("/api/login", async (c) => {
  const input = credentialsSchema.parse(await c.req.json());
  const result = await pool.query<{ id: string; password_hash: string }>("SELECT id,password_hash FROM users WHERE email=$1", [input.email]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(input.password, user.password_hash))) return c.json({ error: "ログインに失敗しました" }, 401);
  const token = randomBytes(32).toString("hex");
  await pool.query("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now() + interval '12 hours')", [hashToken(token), user.id]);
  setCookie(c, "session", token, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: 43200, secure: process.env.NODE_ENV === "production" });
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  const token = getCookie(c, "session");
  const user = await userId(token);
  if (!user || !token) return c.json({ error: "ログインしてください" }, 401);
  c.set("userId", user);
  c.set("sessionHash", hashToken(token));
  await next();
});

function currentUser(c: Context<Env>): string {
  return c.get("userId");
}

app.post("/api/logout", async (c) => {
  const token = getCookie(c, "session");
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(token)]);
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const result = await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [currentUser(c)]);
  return c.json({ ...result.rows[0], id: currentUser(c), codeEnabled: codeMode() !== null });
});

app.route("/api/apps/:id/code", code);
app.route("/api/code-apps", codeCreation);
app.route("/api/vm-apps", createVmRoutes());

app.get("/api/apps", async (c) => {
  const result = await pool.query("SELECT a.id,a.spec,a.version,a.default_visibility,m.role FROM apps a JOIN members m ON a.id=m.app_id WHERE m.user_id=$1 ORDER BY a.id", [currentUser(c)]);
  return c.json(result.rows);
});

app.patch("/api/apps/:id/settings", async (c) => {
  const appAccess = await access(c.req.param("id"), currentUser(c));
  if (!appAccess || appAccess.role !== "owner") return c.json({ error: "権限がありません" }, 403);
  const input = z.object({ defaultVisibility: visibilitySchema }).parse(await c.req.json());
  await pool.query("UPDATE apps SET default_visibility=$2 WHERE id=$1", [appAccess.id, input.defaultVisibility]);
  return c.json({ ok: true });
});

app.post("/api/apps", async (c) => {
  const input = promptSchema.extend({ defaultVisibility: visibilitySchema }).parse(await c.req.json());
  const spec = await generateSpec(input.prompt);
  const id = randomUUID();
  const user = currentUser(c);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO apps (id,owner_id,spec,default_visibility) VALUES ($1,$2,$3,$4)", [id, user, JSON.stringify(spec), input.defaultVisibility]);
    await client.query("INSERT INTO members (app_id,user_id,role) VALUES ($1,$2,'owner')", [id, user]);
    await applySpec(client, id, spec);
    await client.query("INSERT INTO app_versions (app_id,version,spec,prompt) VALUES ($1,1,$2,$3)", [id, JSON.stringify(spec), input.prompt]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  return c.json({ id, spec, version: 1 }, 201);
});

app.post("/api/apps/:id/members", async (c) => {
  const user = currentUser(c);
  const appAccess = await access(c.req.param("id"), user);
  if (!appAccess || appAccess.role !== "owner") return c.json({ error: "権限がありません" }, 403);
  const input = z.object({ email: z.email().transform((value) => value.toLowerCase()) }).parse(await c.req.json());
  const result = await pool.query(
    "INSERT INTO members (app_id,user_id,role) SELECT $1,id,'member' FROM users WHERE email=$2 ON CONFLICT DO NOTHING RETURNING user_id",
    [appAccess.id, input.email],
  );
  if (!result.rowCount) return c.json({ error: "ユーザーが存在しないか、すでに参加しています" }, 400);
  return c.json({ ok: true }, 201);
});

app.delete("/api/apps/:id/members/:userId", async (c) => {
  const appAccess = await access(c.req.param("id"), currentUser(c));
  if (!appAccess || appAccess.role !== "owner") return c.json({ error: "権限がありません" }, 403);
  const memberId = z.uuid().parse(c.req.param("userId"));
  const result = await pool.query("DELETE FROM members WHERE app_id=$1 AND user_id=$2 AND role='member' RETURNING user_id", [appAccess.id, memberId]);
  if (!result.rowCount) return c.json({ error: "メンバーが見つかりません" }, 404);
  return c.json({ ok: true });
});

app.get("/api/apps/:id/members", async (c) => {
  const appAccess = await access(c.req.param("id"), currentUser(c));
  if (!appAccess || appAccess.role !== "owner") return c.json({ error: "権限がありません" }, 403);
  const result = await pool.query("SELECT u.id,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.app_id=$1", [appAccess.id]);
  return c.json(result.rows);
});

app.post("/api/apps/:id/change", async (c) => {
  const appAccess = await access(c.req.param("id"), currentUser(c));
  if (!appAccess || appAccess.role !== "owner") return c.json({ error: "権限がありません" }, 403);
  if (!appAccess.spec.entities.length) return c.json({ error: "コード版の変更は「コードの変更依頼」から行ってください。" }, 422);
  const input = promptSchema.parse(await c.req.json());
  const spec = await generateSpec(input.prompt, appAccess.spec);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ version: number }>("SELECT version FROM apps WHERE id=$1 FOR UPDATE", [appAccess.id]);
    if (current.rows[0]?.version !== appAccess.version) {
      await client.query("ROLLBACK");
      return c.json({ error: "アプリが更新されました。再試行してください" }, 409);
    }
    await applySpec(client, appAccess.id, spec, appAccess.spec);
    const version = appAccess.version + 1;
    await client.query("UPDATE apps SET spec=$2,version=$3 WHERE id=$1", [appAccess.id, JSON.stringify(spec), version]);
    await client.query("INSERT INTO app_versions (app_id,version,spec,prompt) VALUES ($1,$2,$3,$4)", [appAccess.id, version, JSON.stringify(spec), input.prompt]);
    await client.query("COMMIT");
    return c.json({ spec, version });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

app.get("/api/apps/:id/records/:entity", async (c) => {
  const user = currentUser(c);
  const appAccess = await access(c.req.param("id"), user);
  if (!appAccess) return c.json({ error: "権限がありません" }, 403);
  const entity = getEntity(appAccess.spec, c.req.param("entity"));
  if (!entity) return c.json({ error: "データが見つかりません" }, 404);
  const table = `${quoteIdentifier(schemaName(appAccess.id))}.${quoteIdentifier(entity.name)}`;
  const result = await pool.query(`SELECT * FROM ${table} WHERE visibility='shared' OR created_by=$1 OR $2::boolean ORDER BY created_at DESC LIMIT 200`, [user, appAccess.role === "owner"]);
  return c.json(result.rows);
});

app.post("/api/apps/:id/records/:entity", async (c) => {
  const user = currentUser(c);
  const appAccess = await access(c.req.param("id"), user);
  if (!appAccess) return c.json({ error: "権限がありません" }, 403);
  const entity = getEntity(appAccess.spec, c.req.param("entity"));
  if (!entity) return c.json({ error: "データが見つかりません" }, 404);
  const input = z.object({ values: z.unknown(), visibility: visibilitySchema.optional() }).parse(await c.req.json());
  const values = validateRecord(entity, input.values);
  const columns = entity.fields.map((field) => quoteIdentifier(field.name));
  const parameters = entity.fields.map((_, index) => `$${index + 4}`);
  const table = `${quoteIdentifier(schemaName(appAccess.id))}.${quoteIdentifier(entity.name)}`;
  const result = await pool.query(`INSERT INTO ${table} (id,created_by,visibility,${columns.join(",")}) VALUES ($1,$2,$3,${parameters.join(",")}) RETURNING *`, [randomUUID(), user, input.visibility ?? appAccess.default_visibility, ...entity.fields.map((field) => values[field.name])]);
  return c.json(result.rows[0], 201);
});

app.patch("/api/apps/:id/records/:entity/:recordId", async (c) => {
  const user = currentUser(c);
  const appAccess = await access(c.req.param("id"), user);
  if (!appAccess) return c.json({ error: "権限がありません" }, 403);
  const entity = getEntity(appAccess.spec, c.req.param("entity"));
  if (!entity) return c.json({ error: "データが見つかりません" }, 404);
  const recordId = z.uuid().parse(c.req.param("recordId"));
  const input = z.object({ values: z.unknown(), visibility: visibilitySchema }).parse(await c.req.json());
  const values = validateRecord(entity, input.values);
  const assignments = entity.fields.map((field, index) => `${quoteIdentifier(field.name)}=$${index + 5}`);
  const table = `${quoteIdentifier(schemaName(appAccess.id))}.${quoteIdentifier(entity.name)}`;
  const result = await pool.query(
    `UPDATE ${table} SET visibility=$4,${assignments.join(",")} WHERE id=$1 AND (visibility='shared' OR created_by=$2 OR $3::boolean) RETURNING *`,
    [recordId, user, appAccess.role === "owner", input.visibility, ...entity.fields.map((field) => values[field.name])],
  );
  if (!result.rowCount) return c.json({ error: "データが見つかりません" }, 404);
  return c.json(result.rows[0]);
});

app.delete("/api/apps/:id/records/:entity/:recordId", async (c) => {
  const user = currentUser(c);
  const appAccess = await access(c.req.param("id"), user);
  if (!appAccess) return c.json({ error: "権限がありません" }, 403);
  const entity = getEntity(appAccess.spec, c.req.param("entity"));
  if (!entity) return c.json({ error: "データが見つかりません" }, 404);
  const recordId = z.uuid().parse(c.req.param("recordId"));
  const table = `${quoteIdentifier(schemaName(appAccess.id))}.${quoteIdentifier(entity.name)}`;
  const result = await pool.query(`DELETE FROM ${table} WHERE id=$1 AND (visibility='shared' OR created_by=$2 OR $3::boolean) RETURNING id`, [recordId, user, appAccess.role === "owner"]);
  if (!result.rowCount) return c.json({ error: "データが見つかりません" }, 404);
  return c.json({ ok: true });
});

export default app;
