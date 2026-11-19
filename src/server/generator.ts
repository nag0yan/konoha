import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { randomUUID } from "node:crypto";
import { appSpecSchema, checkAdditiveChange, type AppSpec } from "../shared/spec.ts";

const reservation: AppSpec = {
  title: "予約管理",
  entities: [
    { name: "customers", label: "顧客", fields: [{ name: "name", label: "氏名", type: "text" }, { name: "email", label: "メール", type: "text" }] },
    { name: "reservations", label: "予約", fields: [{ name: "customer", label: "顧客名", type: "text" }, { name: "date", label: "日時", type: "text" }] },
  ],
};

export function parseModelSpec(text: string): AppSpec {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return appSpecSchema.parse(JSON.parse(fenced?.[1] ?? trimmed));
}

export class UnsupportedTemplateRequest extends Error {}

export async function generateSpec(prompt: string, previous?: AppSpec): Promise<AppSpec> {
  if (process.env.GENERATOR === "template") {
    if (!previous) {
      if (!prompt.includes("予約") && !prompt.toLowerCase().includes("reservation")) {
        throw new UnsupportedTemplateRequest("定義ベースのテンプレートでは「予約管理を作って」と入力してください。コード版が有効なら、別のアプリを作るときは「コード版」を選んでください。");
      }
      return structuredClone(reservation);
    }
    const next = structuredClone(previous);
    const entity = next.entities.find((item) => item.name === "reservations");
    if (!entity) throw new Error("Reservation entity not found");
    if (prompt.includes("カレンダー") || /\b(?:calendar|date picker)\b/i.test(prompt)) {
      const field = entity.fields.find((item) => item.name === "date" && item.type === "text");
      if (!field) throw new Error("Reservation date text field not found");
      field.widget = "date";
    } else if (prompt.includes("メモ") || prompt.toLowerCase().includes("note")) {
      if (!entity.fields.some((field) => field.name === "note")) {
        entity.fields.push({ name: "note", label: "メモ", type: "text" });
      }
    } else {
      throw new Error("Template generator supports only adding a reservation note or enabling the date picker");
    }
    return appSpecSchema.parse(next);
  }

  const region = process.env.AWS_REGION ?? process.env.MODEL_REGION;
  if (!region) throw new Error("Set AWS_REGION or MODEL_REGION, or explicitly set GENERATOR=template");
  if (process.env.GENERATOR === "agentcore") {
    const agentRuntimeArn = process.env.AGENTCORE_RUNTIME_ARN;
    if (!agentRuntimeArn) throw new Error("Set AGENTCORE_RUNTIME_ARN");
    const client = new BedrockAgentCoreClient({ region });
    const response = await client.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn,
      runtimeSessionId: randomUUID(),
      contentType: "application/json",
      accept: "application/json",
      payload: new TextEncoder().encode(JSON.stringify({ prompt, previous })),
    }));
    if (response.statusCode !== 200 || !response.response) {
      throw new Error(`AgentCore invocation failed with status ${response.statusCode ?? "unknown"}`);
    }
    const body = await response.response.transformToString();
    const spec = parseModelSpec(body);
    if (previous) checkAdditiveChange(previous, spec);
    return spec;
  }
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) throw new Error("Set BEDROCK_MODEL_ID, or explicitly set GENERATOR=template");
  const client = new BedrockRuntimeClient({ region });
  const response = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: [
      'Generate an application schema as JSON only. Format: {"title":"...","entities":[{"name":"customers","label":"...","fields":[{"name":"name","label":"...","type":"text"}]}]}.',
      "Entity and field names must be lowercase ASCII identifiers, field types only text, number, boolean. Maximum 5 entities, 20 fields each.",
      'A text field can have the optional property "widget":"date" to render a date picker. This is UI metadata; the field type stays "text".',
      'For changes, retain every existing entity and field with its existing type, and preserve widget properties unless the user asks to change them. You may add entities or fields when requested.',
      'For a calendar/date picker request, set "widget":"date" on the matching existing text field if present. If a date field is needed and none exists, add one text field with that widget. Do not add a boolean field or represent the widget as a separate field.',
      "Do not output SQL, code, or markdown.",
    ].join(" ") }],
    messages: [{ role: "user", content: [{ text: JSON.stringify({ request: prompt, existing: previous ?? null }) }] }],
    inferenceConfig: { maxTokens: 4096, temperature: 0 },
  }));
  const text = response.output?.message?.content?.find((item) => "text" in item)?.text;
  if (!text) throw new Error("The model returned no application definition");
  const spec = parseModelSpec(text);
  if (previous) checkAdditiveChange(previous, spec);
  return spec;
}
