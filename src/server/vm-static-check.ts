import { Linter } from "eslint";
import globals from "globals";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { filesSchema, type AppFiles } from "./vm-runtime.ts";

type Diagnostic = {
  file: string;
  line: number;
  rule: "no-undef" | "syntax";
  message: string;
};
export type VmRepair = { files: AppFiles; diagnostics: Diagnostic[] };
type Phase = "checking" | "repairing";
const linter = new Linter();

export function checkVmSource(files: AppFiles): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  function check(file: string, source: string, environment: typeof globals.browser | typeof globals.nodeBuiltin, sourceType: "module" | "script", offset = 0) {
    const messages = linter.verify(source, {
      linterOptions: { noInlineConfig: true },
      languageOptions: { ecmaVersion: 2025, globals: environment, sourceType },
      rules: { "no-undef": "error" },
    });
    for (const message of messages) {
      if (message.ruleId !== "no-undef" && !message.fatal) continue;
      const identifier = /^'([\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]{0,79})' is not defined\.$/u.exec(message.message)?.[1];
      diagnostics.push({
        file, line: offset + (message.line ?? 1),
        rule: message.fatal ? "syntax" : "no-undef",
        message: message.fatal ? "Invalid JavaScript syntax." : identifier ? `Undefined identifier: ${identifier}` : "Undefined identifier.",
      });
    }
  }

  for (const file of files) {
    if (/\.(mjs|js)$/.test(file.path)) {
      const server = file.path === "server.mjs" || file.path.startsWith("server/");
      check(file.path, file.content, server ? globals.nodeBuiltin : globals.browser, "module");
    }
    if (file.path.endsWith(".html")) {
      function walk(node: DefaultTreeAdapterTypes.Node) {
        if ("tagName" in node && node.tagName === "script" && node.sourceCodeLocation?.startTag && !node.attrs.some(({ name }) => name === "src")) {
          const type = node.attrs.find(({ name }) => name === "type")?.value.trim().toLowerCase();
          if (!type || ["module", "text/javascript", "application/javascript"].includes(type)) {
            const start = node.sourceCodeLocation.startTag;
            const end = node.sourceCodeLocation.endTag?.startOffset ?? node.sourceCodeLocation.endOffset;
            check(file.path, file.content.slice(start.endOffset, end), globals.browser, type === "module" ? "module" : "script", start.endLine - 1);
          }
        }
        if ("childNodes" in node) node.childNodes.forEach(walk);
      }
      walk(parse(file.content, { sourceCodeLocationInfo: true }));
    }
  }
  return diagnostics.slice(0, 20);
}

export class VmStaticCheckError extends Error {
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map(({ file, line, rule, message }) => `${file}:${line} [${rule}] ${message}`).join("\n"));
  }
}

export async function prepareVmSource(
  initial: () => Promise<AppFiles>,
  onPhase: (phase: Phase) => void,
  repair?: (feedback: VmRepair) => Promise<AppFiles>,
): Promise<AppFiles> {
  let files = filesSchema.parse(await initial());
  for (let attempt = 0; ; attempt++) {
    onPhase("checking");
    const diagnostics = checkVmSource(files);
    if (!diagnostics.length) return files;
    if (!repair || attempt >= 2) throw new VmStaticCheckError(diagnostics);
    onPhase("repairing");
    files = filesSchema.parse(await repair({ files, diagnostics }));
  }
}
