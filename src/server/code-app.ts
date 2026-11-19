import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html, raw } from "hono/html";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "./db.ts";
import { checkSource, codeInstruction, inputSchema, fixtureEdit, runSource, sourceSchema } from "./code-runner.ts";

type Env = { Variables: { userId: string; codeRole: "owner" | "member"; codeAppId: string } };
type Input = z.infer<typeof inputSchema>;
type Revision = { revision: number; source: string; sample_input: Input };
const code = new Hono<Env>();
export const codeCreation = new Hono<{ Variables: { userId: string } }>();
let generating = false;
let nextBedrockEdit = 0;
const failed = "コード版の検証または実行に失敗しました。サーバーログを確認してください。";
const revisionSchema = z.coerce.number().int().positive().max(2147483647);
const sampleSchema = z.string().max(4000).transform((text) => JSON.parse(text)).pipe(inputSchema);
const editSchema = z.object({ prompt: z.string().trim().min(1).max(1000), sample: sampleSchema });
const limitBody = bodyLimit({ maxSize: 24576, onError: (c) => c.json({ error: "リクエストが大きすぎます" }, 413) });
code.use("*", limitBody);
codeCreation.use("*", limitBody);

export function codeMode() {
  const value = process.env.KONOHA_CODE_MODE;
  return process.env.NODE_ENV !== "production" && (value === "fixture" || value === "bedrock") ? value : null;
}

code.use("*", async (c, next) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!codeMode() || !id.success) return c.json({ error: "コード版は利用できません" }, 404);
  const result = await pool.query<{ role: "owner" | "member" }>(
    "SELECT role FROM members WHERE app_id=$1 AND user_id=$2", [id.data, c.get("userId")],
  );
  const role = result.rows[0]?.role;
  if (!role) return c.json({ error: "権限がありません" }, 403);
  c.set("codeRole", role);
  c.set("codeAppId", id.data);
  c.header("Cache-Control", "no-store");
  await next();
});

async function latest(appId: string) {
  return (await pool.query<Revision>("SELECT revision,source,sample_input FROM app_code_revisions WHERE app_id=$1 ORDER BY revision DESC LIMIT 1", [appId])).rows[0] ?? null;
}

async function release(appId: string) {
  return (await pool.query<Revision>(
    "SELECT r.revision,r.source,r.sample_input FROM app_code_releases p JOIN app_code_revisions r USING (app_id, revision) WHERE p.app_id=$1", [appId],
  )).rows[0] ?? null;
}

async function edit(prompt: string, previous: string | null, sampleInput: Input) {
  if (codeMode() === "fixture") return fixtureEdit(previous, prompt);
  const region = process.env.AWS_REGION;
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!region || !modelId) throw new Error("Set AWS_REGION and BEDROCK_MODEL_ID for the code editor");
  const client = new BedrockRuntimeClient({ region, maxAttempts: 1 });
  try {
    const response = await client.send(new ConverseCommand({
      modelId, system: [{ text: codeInstruction }],
      messages: [{ role: "user", content: [{ text: JSON.stringify({ prompt, previous, sampleInput }) }] }],
      inferenceConfig: { maxTokens: 4096, temperature: 0 },
    }), { abortSignal: AbortSignal.timeout(45000) });
    const output = response.output?.message?.content?.find((item) => "text" in item)?.text;
    if (!output) throw new Error("Model returned no code");
    const text = output.trim();
    const json = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text)?.[1] ?? text;
    return z.object({ source: sourceSchema }).strict().parse(JSON.parse(json)).source;
  } finally { client.destroy(); }
}

async function buildRevision<T>(prompt: string, sample: Input, base: () => Promise<string | null>, save: (source: string) => Promise<T>) {
  if (generating || (codeMode() === "bedrock" && nextBedrockEdit > Date.now())) return { status: 429, body: {
    error: "コード生成は実行中か利用間隔の制限中です。少し待って再試行してください。",
  } } as const;
  generating = true;
  if (codeMode() === "bedrock") nextBedrockEdit = Date.now() + 20000;
  try {
    const source = sourceSchema.parse(await edit(prompt, await base(), sample));
    await checkSource(source, sample);
    return { status: 201, body: await save(source) } as const;
  } catch (error) {
    console.error("Code revision failed:", error instanceof Error ? error.name : "UnknownError");
    return { status: 422, body: { error: "コードの生成または検証に失敗しました。アプリは変更されていません。" } } as const;
  } finally { generating = false; }
}

async function insertRevision(db: Pick<PoolClient, "query">, appId: string, source: string, sample: Input) {
  const { rows } = await db.query<{ revision: number }>(
    "INSERT INTO app_code_revisions (app_id,source,sample_input) VALUES ($1,$2,$3) RETURNING revision", [appId, source, JSON.stringify(sample)],
  );
  if (!rows[0]) throw new Error("Missing revision after insert");
  return rows[0];
}

codeCreation.post("/", async (c) => {
  const owner = c.get("userId");
  if (!codeMode()) return c.json({ error: "コード版は利用できません" }, 404);
  const { prompt, sample, title } = editSchema.extend({ title: z.string().trim().min(1).max(100).optional() }).parse(await c.req.json());
  const result = await buildRevision(prompt, sample, async () => null, async (source) => {
    const id = randomUUID();
    const spec = { title: title ?? Array.from(prompt).slice(0, 60).join(""), entities: [] };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO apps (id,owner_id,spec,default_visibility) VALUES ($1,$2,$3,'private')", [id, owner, JSON.stringify(spec)]);
      await client.query("INSERT INTO members (app_id,user_id,role) VALUES ($1,$2,'owner')", [id, owner]);
      const { revision } = await insertRevision(client, id, source, sample);
      await client.query("COMMIT");
      return { id, revision };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });
  return c.json(result.body, result.status);
});

code.get("/", async (c) => {
  const canEdit = c.get("codeRole") === "owner";
  const appId = c.get("codeAppId");
  const active = await release(appId);
  if (!canEdit) return c.json({ canEdit, active: active?.revision ?? null, draft: null, previous: null });
  const revisions = (await pool.query<Revision>(
    "SELECT revision,source,sample_input FROM app_code_revisions WHERE app_id=$1 ORDER BY revision DESC LIMIT 2", [appId],
  )).rows;
  return c.json({ canEdit, active: active?.revision ?? null, draft: revisions[0] ?? null, previous: revisions[1] ?? null });
});

code.post("/", async (c) => {
  if (c.get("codeRole") !== "owner") return c.json({ error: "権限がありません" }, 403);
  const { prompt, sample } = editSchema.parse(await c.req.json());
  const appId = c.get("codeAppId");
  const result = await buildRevision(prompt, sample,
    async () => (await latest(appId))?.source ?? null,
    (source) => insertRevision(pool, appId, source, sample));
  return c.json(result.body, result.status);
});

code.post("/:revision/approve", async (c) => {
  if (c.get("codeRole") !== "owner") return c.json({ error: "権限がありません" }, 403);
  const revision = revisionSchema.parse(c.req.param("revision"));
  const approved = await pool.query<{ revision: number }>(`
    INSERT INTO app_code_releases (app_id, revision)
    SELECT app_id, revision FROM app_code_revisions WHERE app_id=$1
      AND revision=(SELECT max(revision) FROM app_code_revisions WHERE app_id=$1) AND revision=$2
    ON CONFLICT (app_id) DO UPDATE SET revision=EXCLUDED.revision
    WHERE app_code_releases.revision < EXCLUDED.revision
    RETURNING revision`, [c.get("codeAppId"), revision]);
  return approved.rowCount ? c.json({ active: revision }) : c.json({ error: "最新版のみ公開できます。画面を更新してください。" }, 409);
});

type View = Awaited<ReturnType<typeof runSource>>["view"];
async function render(view: View): Promise<string | ReturnType<typeof raw>> {
  if (typeof view === "string") return view;
  // The runner validates every tag against a closed list; all children are HTML-escaped.
  const children = await Promise.all(view.children.map(render));
  return html`${raw(`<${view.tag}>`)}${children}${raw(`</${view.tag}>`)}`;
}

code.get("/preview/:revision", async (c) => {
  if (c.get("codeRole") !== "owner") return c.json({ error: "権限がありません" }, 403);
  const revision = revisionSchema.parse(c.req.param("revision"));
  const draft = await latest(c.get("codeAppId"));
  if (!draft || draft.revision !== revision) return c.json({ error: "プレビューが見つかりません" }, 404);
  try {
    const { view } = await runSource(draft.source, draft.sample_input);
    c.header("Content-Security-Policy", "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    c.header("X-Content-Type-Options", "nosniff");
    return c.html(await html`<!doctype html><html lang="ja"><meta charset="utf-8"><title>コード版プレビュー</title><body>${await render(view)}</body></html>`);
  } catch (error) {
    console.error("Code preview failed:", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: failed }, 422);
  }
});

code.get("/release", async (c) => {
  const active = await release(c.get("codeAppId"));
  if (!active) return c.json({ error: "公開版がありません" }, 404);
  try {
    const { result, view } = await runSource(active.source, active.sample_input);
    if (c.req.query("format") !== "html") return c.json(result);
    c.header("Content-Security-Policy", "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    c.header("X-Content-Type-Options", "nosniff");
    return c.html(await html`<!doctype html><html lang="ja"><meta charset="utf-8"><title>コード公開版</title><body>${await render(view)}</body></html>`);
  } catch (error) {
    console.error("Code release failed:", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: failed }, 422);
  }
});

code.post("/release/run", async (c) => {
  const active = await release(c.get("codeAppId"));
  if (!active) return c.json({ error: "公開版がありません" }, 404);
  const { sample } = z.object({ sample: sampleSchema }).parse(await c.req.json());
  try {
    const { result } = await runSource(active.source, sample);
    return c.json(result);
  } catch (error) {
    console.error("Code release execution failed:", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: failed }, 422);
  }
});

export default code;
