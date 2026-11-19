import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const fileSchema = z.object({
  path: z.string().max(100).regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:mjs|js|html|css|json|svg)$/),
  content: z.string().max(32000),
}).strict();
export const filesSchema = z.array(fileSchema).min(1).max(16).refine((files) => {
  const paths = new Set(files.map((file) => file.path));
  return paths.size === files.length && paths.has("server.mjs") &&
    files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) <= 128000;
}, "Expected unique application files including server.mjs");

export type AppFiles = z.infer<typeof filesSchema>;
export type RunningVm = { socket: string; exited: Promise<void>; stop: () => void };
const image = "konoha-qemu:local";

function probe(socket: string) {
  return new Promise<boolean>((resolve) => {
    const req = request({ socketPath: socket, path: "/", timeout: 1000 }, (res) => {
      resolve(res.statusCode === 200 && /^text\/html(?:\s*;|$)/i.test(res.headers["content-type"] ?? ""));
      res.destroy();
    });
    req.once("error", () => resolve(false));
    req.once("timeout", () => req.destroy());
    req.end();
  });
}

export async function bootVm(files: AppFiles): Promise<RunningVm> {
  const checked = filesSchema.parse(files);
  const workspace = await mkdtemp("/tmp/konoha-guest-");
  const cleanup = () => rm(workspace, { recursive: true, force: true });
  const input = join(workspace, "input");
  const bridge = join(workspace, "bridge");
  const socket = join(bridge, "http.sock");
  try {
    await mkdir(bridge, { mode: 0o700 });
    for (const file of checked) {
      const path = join(input, "app", file.path);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, file.content, { flag: "wx" });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  const name = `konoha-vm-${randomUUID()}`;
  const child = spawn("docker", [
    "run", "--rm", "--pull=never", "--name", name, "--label", "app=konoha-qemu",
    "--network=none", "--user", `${process.getuid?.()}:${process.getgid?.()}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
    "--tmpfs", "/tmp:rw,size=180m", "--memory=768m", "--memory-swap=768m", "--cpus=1", "--pids-limit=64",
    "--log-driver=none", "--mount", `type=bind,src=${bridge},dst=/bridge`,
    "--mount", `type=bind,src=${input},dst=/input,readonly`, image,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let running = true;
  let stopping = false;
  let diagnostics = "";
  const capture = (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-3000); };
  child.stdout.setEncoding("utf8").on("data", capture);
  child.stderr.setEncoding("utf8").on("data", capture);
  child.once("error", (error) => capture(error.message));
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      running = false;
      void cleanup().catch((error: unknown) => console.error("VM workspace cleanup failed", error)).finally(resolve);
    });
  });
  const stop = () => {
    if (!running || stopping) return;
    stopping = true;
    const remover = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
    remover.once("error", (error) => console.error("VM stop failed", error.message));
    remover.once("exit", (code) => {
      if (code !== 0 && running) child.kill("SIGTERM");
    });
  };
  const deadline = Date.now() + 30000;
  try {
    while (running && Date.now() < deadline) {
      if (await probe(socket)) return { socket, exited, stop };
      await delay(400);
    }
    const tail = diagnostics.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
    throw new Error(`VM did not serve HTTP 200 text/html at / within 30 seconds${tail ? `\n${tail}` : ""}`);
  } catch (error) {
    stop();
    await Promise.race([exited, delay(2500)]);
    throw error;
  }
}
