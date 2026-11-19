import { Hono } from "hono";
import { z, ZodError } from "zod";
import { appSpecSchema, type AppSpec } from "./spec.ts";

type Generator = (prompt: string, previous?: AppSpec) => Promise<AppSpec>;

export function createAgentApp(generate: Generator): Hono {
  const app = new Hono();
  app.get("/ping", (c) => c.json({ status: "Healthy" }));
  app.post("/invocations", async (c) => {
    try {
      const request = z.object({
        prompt: z.string().min(1).max(4000),
        previous: appSpecSchema.optional(),
      }).parse(await c.req.json());
      const spec = await generate(request.prompt, request.previous);
      return c.json(appSpecSchema.parse(spec));
    } catch (error) {
      if (error instanceof ZodError || error instanceof SyntaxError) {
        return c.json({ error: "Invalid request or generated definition" }, 400);
      }
      console.error("Agent invocation failed:", error);
      return c.json({ error: "Agent generation failed" }, 500);
    }
  });
  return app;
}
