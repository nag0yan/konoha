import { serve } from "@hono/node-server";
import { createAgentApp } from "./app.ts";
import { generateSpec } from "./generator.ts";

const app = createAgentApp(generateSpec);
serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8080 });
