import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { test } from "node:test";
import { bootVm, filesSchema } from "./vm-runtime.ts";
import { checkVmSource, prepareVmSource, VmStaticCheckError } from "./vm-static-check.ts";

const missingImport = [{ path: "server.mjs", content: 'path.extname("index.html");' }];

test("VM source only accepts unique relative app files with a server entry point", () => {
  const entry = { path: "server.mjs", content: "entry" };
  assert.ok(filesSchema.safeParse([entry, { path: "public/index.html", content: "<canvas>" }]).success);
  for (const files of [[entry, { path: "../init.mjs", content: "outside" }], [entry, entry], [{ path: "index.html", content: "" }]]) {
    assert.equal(filesSchema.safeParse(files).success, false);
  }
});

test("generated code uses fixed checks and separate server and browser globals", () => {
  const diagnostics = checkVmSource([
    { path: "server.mjs", content: '/* eslint-disable no-undef */\npath.extname("index.html");\nconsole.log(process.env.PORT);' },
    { path: "public/client.js", content: "document.querySelector('canvas');\nprocess.exit();" },
    { path: "public/index.html", content: "<script type=\"application/json\">{}</script>\n<script>\nwindow.alert(missing);\n</script>" },
    { path: "server/helper.mjs", content: "const = 'invalid';" },
  ]);
  assert.deepEqual(diagnostics, [
    { file: "server.mjs", line: 2, rule: "no-undef", message: "Undefined identifier: path" },
    { file: "public/client.js", line: 2, rule: "no-undef", message: "Undefined identifier: process" },
    { file: "public/index.html", line: 3, rule: "no-undef", message: "Undefined identifier: missing" },
    { file: "server/helper.mjs", line: 1, rule: "syntax", message: "Invalid JavaScript syntax." },
  ]);
});

test("failed candidates never pass the gate and repair stops after two attempts", async () => {
  const phases: string[] = [];
  let repairs = 0;
  await assert.rejects(prepareVmSource(async () => missingImport, (phase) => phases.push(phase), async ({ files, diagnostics }) => {
    repairs++;
    assert.deepEqual(files, missingImport);
    assert.deepEqual(diagnostics, [{ file: "server.mjs", line: 1, rule: "no-undef", message: "Undefined identifier: path" }]);
    return missingImport;
  }), VmStaticCheckError);
  assert.equal(repairs, 2);
  assert.deepEqual(phases, ["checking", "repairing", "checking", "repairing", "checking"]);
  await assert.rejects(prepareVmSource(async () => missingImport, () => {}), VmStaticCheckError);
});

test("QEMU guest serves a normal browser app after a missing import is repaired", { skip: process.env.KONOHA_TEST_VM !== "1" }, async () => {
  const source = await readFile(new URL("../../infra/vm/fixture/app/server.mjs", import.meta.url), "utf8");
  const candidate = source + '\npath.extname("index.html");';
  const files = await prepareVmSource(async () => [{ path: "server.mjs", content: candidate }], () => {}, async (feedback) => {
    assert.equal(feedback.diagnostics[0]?.message, "Undefined identifier: path");
    return [{ path: "server.mjs", content: 'import * as path from "node:path";\n' + candidate }];
  });
  const vm = await bootVm(files);
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: vm.socket, path: "/", timeout: 5000 }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
        res.once("end", () => res.statusCode === 200 ? resolve(body) : reject(new Error(`Unexpected status ${res.statusCode}`)));
        res.once("error", reject);
      });
      req.once("error", reject);
      req.once("timeout", () => req.destroy(new Error("VM HTTP timeout")));
      req.end();
    });
    assert.match(body, /<canvas\b/);
    assert.match(body, /canvas\.onpointermove/);
  } finally { vm.stop(); await vm.exited; }
});
