import { randomBytes, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { ConverseCommand, BedrockRuntimeClient, type Message } from "@aws-sdk/client-bedrock-runtime";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { pool } from "./db.ts";
import { bootVm, filesSchema, type AppFiles, type RunningVm } from "./vm-runtime.ts";
import { prepareVmSource, VmStaticCheckError, type VmRepair } from "./vm-static-check.ts";

type State = { status: "generating" | "checking" | "repairing" | "starting" | "ready" | "failed"; error?: string; vm?: RunningVm };
type Entry = { id: string; title: string };
const jobs = new Map<string, State>();
const revisions = new Map<string, State>();
const retiring = new Set<RunningVm>();
const passes = new Map<string, { id: string; session: string; expires: number; redeemed: boolean }>();
const previewPort = 3002;
const uuid = z.uuid();
const running = () => jobs.size + revisions.size + retiring.size;
const available = () => process.env.NODE_ENV !== "production";
let nextGenerationAt = 0;

export async function generateVmFiles(prompt: string, repair?: VmRepair, base?: AppFiles) {
  const region = process.env.AWS_REGION ?? "ap-northeast-1";
  const modelId = process.env.BEDROCK_MODEL_ID ?? "jp.amazon.nova-2-lite-v1:0";
  const client = new BedrockRuntimeClient({ region, maxAttempts: 1 });
  const messages: Message[] = [
    { role: "user", content: [{ text: base && !repair ? JSON.stringify({ changeRequest: prompt, currentFiles: base }) : prompt }] },
  ];
  if (repair) messages.push(
    { role: "assistant", content: [{ text: JSON.stringify(repair.files) }] },
    { role: "user", content: [{ text: JSON.stringify({ staticDiagnostics: repair.diagnostics }) }] },
  );
  try {
    const reply = await client.send(new ConverseCommand({
      modelId, inferenceConfig: { maxTokens: 6500, temperature: 0 },
      system: [{ text: [
        "Build a small, genuinely working web application from the user's requirements.",
        'Return only a JSON array of objects with "path" and "content" strings.',
        "Include server.mjs which listens on Number(process.env.PORT), process.env.HOST.",
        'GET / must return HTTP 200 with Content-Type: text/html; charset=utf-8. Handle "/" explicitly as the HTML entry page: do not infer its media type from the extension of "/". Never return application/octet-stream for HTML.',
        "If serving separate files, set Content-Type: text/css for CSS and text/javascript for JavaScript.",
        "Use only Node built-ins and browser HTML, CSS and JavaScript. No dependencies or network. Serve files using paths relative to server.mjs. Use relative URLs.",
        "Put any additional server-side JavaScript under server/; standalone JavaScript in other locations is checked as browser code. Explicitly import all Node built-in modules you use. Avoid undefined identifiers.",
        "If supplied with a previous answer and static diagnostics, fix the errors while preserving requested behavior and return the complete file array.",
        "When revising an existing application, use the supplied application files as the base, make the requested change, and preserve unrelated behavior. Return the complete file array.",
        "Supported file extensions: mjs, js, html, css, json, svg. Keep files short. Implement the functionality, not a mockup.",
      ].join(" ") }],
      messages,
    }), { abortSignal: AbortSignal.timeout(60000) });
    const text = reply.output?.message?.content?.find((item) => "text" in item)?.text?.trim();
    if (!text || reply.stopReason === "max_tokens") throw new Error("Missing or truncated model response");
    const json = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text)?.[1] ?? text;
    return filesSchema.parse(JSON.parse(json));
  } finally { client.destroy(); }
}

async function launch(id: string, prepare: () => Promise<AppFiles>, state: State, boot: typeof bootVm, options?: {
  repair?: (feedback: VmRepair) => Promise<AppFiles>;
  baseRevision?: number;
}) {
  const baseRevision = options?.baseRevision;
  const revise = baseRevision !== undefined;
  try {
    const files = await prepareVmSource(prepare, (phase) => { state.status = phase; }, options?.repair);
    state.status = "starting";
    if (!revise) await pool.query("UPDATE vm_apps SET files=$2 WHERE id=$1", [id, JSON.stringify(files)]);
    const vm = await boot(files);
    state.vm = vm;
    if (revise) {
      const { rowCount } = await pool.query(
        "UPDATE vm_apps SET files=$2, revision=revision+1, revision_error=NULL, error=NULL WHERE id=$1 AND revision=$3",
        [id, JSON.stringify(files), baseRevision],
      );
      if (!rowCount) throw new Error("Missing VM app during revision");
      const previous = jobs.get(id)?.vm;
      jobs.set(id, state);
      if (previous) retire(previous);
    }
    state.status = "ready";
    void vm.exited.then(() => {
      if (jobs.get(id) !== state) return;
      jobs.delete(id);
      for (const [key, pass] of passes) if (pass.id === id) passes.delete(key);
    });
  } catch (error) {
    if (state.vm) retire(state.vm);
    console.error("VM app failed during", state.status, error instanceof Error ? (state.status === "starting" || error instanceof VmStaticCheckError ? error.message : error.name) : "UnknownError");
    const message = error instanceof VmStaticCheckError
      ? `コードが静的検査に合格しなかったため、VMを起動しませんでした。${error.message.split("\n")[0]}`
      : state.status === "repairing"
      ? "静的検査で見つかったエラーを自動修正できませんでした。要望を短くしてもう一度お試しください。"
      : state.status === "generating"
      ? "コードを生成できませんでした。AWS認証・モデル利用権限を確認し、要望を短くしてもう一度お試しください。"
      : "VMを起動できませんでした。実行イメージと、アプリのHTTP応答を確認してください。";
    try {
      await pool.query(revise ? "UPDATE vm_apps SET revision_error=$2 WHERE id=$1" : "UPDATE vm_apps SET error=$2 WHERE id=$1", [id, message]);
    }
    catch (writeError) { console.error("Could not save VM failure", writeError); }
    if (!revise) jobs.delete(id);
  } finally {
    if (revise) revisions.delete(id);
  }
}

function retire(vm: RunningVm) {
  retiring.add(vm);
  void vm.exited.then(() => retiring.delete(vm));
  vm.stop();
}

export function createVmRoutes(generateFiles = generateVmFiles, boot = bootVm) {
  const routes = new Hono<{ Variables: { userId: string; sessionHash: string } }>();
  const key = () => randomBytes(32).toString("hex");
  routes.use("*", bodyLimit({ maxSize: 16384, onError: (c) => c.json({ error: "要望が長すぎます" }, 413) }));
  routes.use("*", async (c, next) => {
    if (!available()) return c.json({ error: "ローカル実験専用です" }, 404);
    c.header("Cache-Control", "no-store");
    await next();
  });
  routes.get("/", async (c) => {
    const { rows } = await pool.query<Entry & { error: string | null; saved: boolean; revision: number; revision_error: string | null }>(
      "SELECT id,title,error,revision,revision_error,(files IS NOT NULL) AS saved FROM vm_apps WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50", [c.get("userId")],
    );
    return c.json(rows.map(({ id, title, error, saved, revision, revision_error }) => ({
      id, title, error, saved, revision, revisionError: revision_error, revisionStatus: revisions.get(id)?.status ?? null,
      status: jobs.get(id)?.status ?? (error ? "failed" : "stopped"),
    })));
  });
  routes.post("/", async (c) => {
    const { prompt } = z.object({ prompt: z.string().trim().min(1).max(2000) }).parse(await c.req.json());
    if (running() >= 2) return c.json({ error: "実行中のVMが上限に達しています。停止してからお試しください。" }, 429);
    if (Date.now() < nextGenerationAt) return c.json({ error: "生成リクエストが多すぎます。少し待って再試行してください。" }, 429);
    const id = randomUUID();
    const state: State = { status: "generating" };
    nextGenerationAt = Date.now() + 15000;
    jobs.set(id, state);
    try {
      await pool.query("INSERT INTO vm_apps (id,owner_id,title) VALUES ($1,$2,$3)", [id, c.get("userId"), Array.from(prompt).slice(0, 60).join("")]);
    } catch (error) {
      jobs.delete(id);
      throw error;
    }
    void launch(id, () => generateFiles(prompt), state, boot, { repair: (feedback) => generateFiles(prompt, feedback) });
    return c.json({ id }, 202);
  });
  routes.post("/:id/revise", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const { prompt } = z.object({ prompt: z.string().trim().min(1).max(2000) }).parse(await c.req.json());
    const { rows: [app] } = await pool.query<{ files: unknown; revision: number }>("SELECT files,revision FROM vm_apps WHERE id=$1 AND owner_id=$2", [id, c.get("userId")]);
    if (!app) return c.json({ error: "アプリが見つかりません" }, 404);
    if (!app.files) return c.json({ error: "修正できる保存済みコードがありません" }, 409);
    const current = jobs.get(id);
    if (revisions.has(id) || (current && current.status !== "ready")) return c.json({ error: "このアプリは処理中です" }, 409);
    if (running() >= 2) return c.json({ error: "修正版を起動する空きがありません。別のVMを停止してからお試しください。" }, 429);
    if (Date.now() < nextGenerationAt) return c.json({ error: "生成リクエストが多すぎます。少し待って再試行してください。" }, 429);
    const base = filesSchema.parse(app.files);
    const state: State = { status: "generating" };
    revisions.set(id, state);
    nextGenerationAt = Date.now() + 15000;
    try { await pool.query("UPDATE vm_apps SET revision_error=NULL WHERE id=$1", [id]); }
    catch (error) { revisions.delete(id); throw error; }
    void launch(id, () => generateFiles(prompt, undefined, base), state, boot, {
      baseRevision: app.revision, repair: (feedback) => generateFiles(prompt, feedback, base),
    });
    return c.json({ id }, 202);
  });
  routes.post("/:id/start", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const { rows: [app] } = await pool.query<{ files: unknown }>("SELECT files FROM vm_apps WHERE id=$1 AND owner_id=$2", [id, c.get("userId")]);
    if (!app) return c.json({ error: "アプリが見つかりません" }, 404);
    if (!app.files) return c.json({ error: "保存済みコードがありません" }, 409);
    if (revisions.has(id)) return c.json({ error: "このアプリは修正中です" }, 409);
    if (jobs.has(id) || running() >= 2) return c.json({ error: "すでに起動中か、実行上限に達しています" }, 429);
    const state: State = { status: "starting" };
    jobs.set(id, state);
    try { await pool.query("UPDATE vm_apps SET error=NULL WHERE id=$1", [id]); }
    catch (error) { jobs.delete(id); throw error; }
    void launch(id, async () => filesSchema.parse(app.files), state, boot);
    return c.json({ id }, 202);
  });
  routes.post("/:id/stop", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const result = await pool.query("SELECT 1 FROM vm_apps WHERE id=$1 AND owner_id=$2", [id, c.get("userId")]);
    if (!result.rowCount) return c.json({ error: "アプリが見つかりません" }, 404);
    if (revisions.has(id)) return c.json({ error: "このアプリは修正中です" }, 409);
    const vm = jobs.get(id)?.vm;
    if (!vm) return c.json({ error: "VMは起動していません" }, 409);
    vm.stop();
    return c.json({ ok: true }, 202);
  });
  routes.get("/:id/open", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const result = await pool.query("SELECT 1 FROM vm_apps WHERE id=$1 AND owner_id=$2", [id, c.get("userId")]);
    if (!result.rowCount) return c.json({ error: "アプリが見つかりません" }, 404);
    if (jobs.get(id)?.status !== "ready") return c.json({ error: "アプリはまだ起動していません" }, 409);
    for (const [token, pass] of passes) if (pass.expires <= Date.now()) passes.delete(token);
    if (passes.size >= 256) return c.json({ error: "開いているプレビューが多すぎます" }, 429);
    const ticket = key();
    passes.set(ticket, { id, session: c.get("sessionHash"), expires: Date.now() + 30000, redeemed: false });
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(`http://${id}.localhost:${previewPort}/_konoha/open?ticket=${ticket}`);
  });
  return routes;
}

export function stopVms() {
  for (const state of jobs.values()) state.vm?.stop();
  for (const state of revisions.values()) state.vm?.stop();
  for (const vm of retiring) vm.stop();
}

export function startPreviewGateway() {
  if (!available()) return;
  const gateway = createServer({ maxHeaderSize: 8192, requestTimeout: 10000 }, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const fail = (status: number) => { res.writeHead(status); res.end(); };
    const host = req.headers.host ?? "";
    const id = /^([a-f0-9-]+)\.localhost:3002$/.exec(host)?.[1];
    if (!id || !uuid.safeParse(id).success || !req.url?.startsWith("/") || req.url.startsWith("//")) return fail(404);
    const vm = jobs.get(id)?.vm;
    if (!vm) return fail(404);
    const path = req.url;
    if (path.includes("\\")) return fail(400);
    const url = new URL(path, `http://${host}`);
    const open = req.method === "GET" && url.pathname === "/_konoha/open";
    const ticket = (open ? url.searchParams.get("ticket") : getCookieFromNode(req.headers.cookie)) ?? "";
    const pass = passes.get(ticket);
    if (!pass || pass.id !== id || pass.expires <= Date.now() || pass.redeemed === open) return fail(403);
    void pool.query("SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now()", [pass.session]).then((session) => {
      if (!session.rowCount || pass.redeemed === open) return fail(403);
      if (open) {
        pass.redeemed = true;
        pass.expires = Date.now() + 30 * 60 * 1000;
        const cookie = randomBytes(32).toString("hex");
        passes.delete(ticket);
        passes.set(cookie, pass);
        res.writeHead(303, { Location: "/", "Set-Cookie": `konoha_vm=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800` });
        res.end();
        return;
      }
      if (!["GET", "HEAD"].includes(req.method ?? "") && req.headers.origin !== `http://${host}`) return fail(403);
      const length = req.headers["content-length"];
      if ((length && Number(length) > 1024 * 1024) || req.headers["transfer-encoding"]) return fail(413);
      const headers = {
        ...(length ? { "content-length": length } : {}),
        ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
      };
      const upstream = request({ socketPath: vm.socket, path, method: req.method, headers, timeout: 10000 }, (response) => {
        const status = response.statusCode;
        if (!status || status < 200 || status > 599) { response.destroy(); return fail(502); }
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (response.headers["content-type"]) res.setHeader("Content-Type", response.headers["content-type"]);
        const location = response.headers.location;
        if (location && /^\/(?![\\/])/.test(location) && !location.includes("\\")) res.setHeader("Location", location);
        res.writeHead(status);
        response.once("error", () => res.destroy());
        response.pipe(res);
      });
      upstream.once("timeout", () => upstream.destroy());
      upstream.once("error", () => { if (!res.headersSent) fail(502); else res.destroy(); });
      res.once("close", () => upstream.destroy());
      req.pipe(upstream);
    }).catch((error: unknown) => {
      console.error("VM preview authorization failed", error);
      if (!res.headersSent) fail(500); else res.destroy();
    });
  });
  return gateway.listen(previewPort, "127.0.0.1");
}

function getCookieFromNode(cookie?: string) {
  return /(?:^|;\s*)konoha_vm=([a-f0-9]{64})(?:;|$)/.exec(cookie ?? "")?.[1];
}
