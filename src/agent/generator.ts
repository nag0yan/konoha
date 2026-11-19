import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { appSpecSchema, checkAdditiveChange, type AppSpec } from "./spec.ts";

export function parseModelSpec(text: string): AppSpec {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return appSpecSchema.parse(JSON.parse(fenced?.[1] ?? trimmed));
}

export async function generateSpec(prompt: string, previous?: AppSpec): Promise<AppSpec> {
  const region = process.env.AWS_REGION ?? process.env.MODEL_REGION;
  if (!region) throw new Error("Set AWS_REGION or MODEL_REGION");
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) throw new Error("Set BEDROCK_MODEL_ID");
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
