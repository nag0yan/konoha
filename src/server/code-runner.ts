import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const docker = promisify(execFile);
export const sourceSchema = z.string().min(1).max(16000);
export const inputSchema = z.record(z.string(), z.json());
const tags = ["section", "h1", "h2", "p", "strong", "ul", "li", "table", "thead", "tbody", "tr", "th", "td"] as const;
type Element = string | { tag: typeof tags[number]; children: Element[] };
function elementSchema(depth: number): z.ZodType<Element> {
  const text = z.string().max(500);
  return depth === 0 ? text : z.union([text, z.object({
    tag: z.enum(tags), children: z.array(elementSchema(depth - 1)).max(30),
  }).strict()]);
}
const resultSchema = z.object({
  result: z.json(),
  view: elementSchema(8),
});

const driver = `
const fs = require("node:fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
(async () => {
  const app = await import("data:text/javascript;base64," + Buffer.from(request.source).toString("base64"));
  const result = await app.handle(request.input);
  process.stdout.write(JSON.stringify({ result, view: await app.render(structuredClone(result)) }));
})().catch(() => { process.exitCode = 1; });
`;

const starter = `export function handle(input) {
  return {keys: Object.keys(input)};
}

export function render({keys}) {
  return {tag: "section", children: [
    {tag: "h1", children: ["入力項目"]},
    {tag: "ul", children: keys.map(key => ({tag: "li", children: [key]}))}
  ]};
}`;

export const codeInstruction = `Edit a JavaScript ES module for the requested application. Return JSON with exactly one key "source" containing the complete ES module. Implement handle(input) accepting a JSON object and returning a JSON value, and render(result) returning text or a tree of {tag,children:[]} where tags are ${tags.join(", ")}. Use sampleInput as an example, not a hardcoded result; handle absent or empty input fields. If previous is supplied, preserve unrelated behavior. No imports, dependencies, network, DOM, credentials, HTML strings or filesystem. Generated code is for synthetic data only.`;

let running = 0;
export async function runSource(source: string, input: z.infer<typeof inputSchema>) {
  if (running >= 2) throw new Error("Sandbox capacity exceeded");
  running++;
  const name = `konoha-code-${randomUUID()}`;
  let interrupted = false;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("docker", [
        "run", "--rm", "--pull=never", "--name", name, "--label", "app=konoha-code",
        "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--user=65534:65534", "--pids-limit=32", "--memory=128m", "--memory-swap=128m",
        "--cpus=0.5", "--log-driver=none", "-i", "--entrypoint=node", "node:24-alpine", "-e", driver,
      ], { stdio: ["pipe", "pipe", "ignore"] });
      let output = "";
      const stop = (error: Error) => {
        interrupted = true;
        child.kill("SIGKILL");
        reject(error);
      };
      const timer = setTimeout(() => stop(new Error("Sandbox timed out")), 8000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (interrupted) return;
        output += chunk;
        if (output.length > 96000) stop(new Error("Sandbox output limit exceeded"));
      });
      child.once("error", reject);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (!interrupted && error.code !== "EPIPE") stop(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error("Sandbox execution failed; check the code or confirm node:24-alpine is installed"));
      });
      child.stdin.end(JSON.stringify({ source, input }));
    });
    return resultSchema.parse(JSON.parse(output));
  } finally {
    try {
      if (interrupted) {
        await docker("docker", ["rm", "-f", name], { timeout: 2000 }).catch((error: unknown) => {
          if (!(error instanceof Error) || !error.message.includes("No such container")) console.error("Sandbox cleanup failed", error);
        });
      }
    } finally { running--; }
  }
}

export async function checkSource(source: string, input: z.infer<typeof inputSchema>) {
  await runSource(source, input);
  await runSource(source, {});
}

export function fixtureEdit(previous: string | null, prompt: string) {
  const heading = JSON.stringify(prompt.slice(0, 100));
  // The fixture is a deterministic smoke-test generator, not the AI editor.
  return (previous ?? starter).replace(/\{tag: "h1", children: \[.*\]\}/, () => `{tag: "h1", children: [${heading}]}`);
}
