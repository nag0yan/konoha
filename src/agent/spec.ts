import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/)
  .refine((value) => !["id", "created_by", "visibility", "created_at"].includes(value), "reserved name");

export const fieldSchema = z.object({
  name: identifier,
  label: z.string().min(1).max(80),
  type: z.enum(["text", "number", "boolean"]),
  widget: z.literal("date").optional(),
}).refine((field) => field.widget === undefined || field.type === "text", {
  path: ["widget"],
  message: "Date input requires a text field",
});

export const entitySchema = z.object({
  name: identifier,
  label: z.string().min(1).max(80),
  fields: z.array(fieldSchema).min(1).max(20),
}).superRefine((entity, context) => {
  if (new Set(entity.fields.map((field) => field.name)).size !== entity.fields.length) {
    context.addIssue({ code: "custom", message: "Duplicate field names" });
  }
});

export const appSpecSchema = z.object({
  title: z.string().min(1).max(100),
  entities: z.array(entitySchema).min(1).max(5),
}).superRefine((spec, context) => {
  if (new Set(spec.entities.map((entity) => entity.name)).size !== spec.entities.length) {
    context.addIssue({ code: "custom", message: "Duplicate entity names" });
  }
});

export type AppSpec = z.infer<typeof appSpecSchema>;

export function checkAdditiveChange(previous: AppSpec, next: AppSpec): void {
  for (const entity of previous.entities) {
    const newEntity = next.entities.find((item) => item.name === entity.name);
    if (!newEntity) throw new Error(`Entity ${entity.name} cannot be removed`);
    for (const field of entity.fields) {
      const newField = newEntity.fields.find((item) => item.name === field.name);
      if (!newField || newField.type !== field.type) {
        throw new Error(`Field ${entity.name}.${field.name} cannot be removed or change type`);
      }
    }
  }
}

