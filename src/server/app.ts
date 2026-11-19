import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z, ZodError } from "zod";
import { pool } from "./db.ts";
import { createVmRoutes } from "./vm-apps.ts";

const scrypt = promisify(scryptCallback);
type Env = { Variables: { userId: string; sessionHash: string } };
const app = new Hono<Env>();
const credentialsSchema = z.object({ email: z.email().max(254).transform((value) => value.toLowerCase()), password: z.string().min(12).max(200) });

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

app.onError((error, c) => {
  if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: "入力内容が正しくありません" }, 400);
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
  return c.json({ ...result.rows[0], id: currentUser(c) });
});

app.route("/api/vm-apps", createVmRoutes());

export default app;
