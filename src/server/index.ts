import { serve } from "@hono/node-server";
import app from "./app.ts";
import { initialize } from "./db.ts";
import { startPreviewGateway, stopVms } from "./vm-apps.ts";

await initialize();
startPreviewGateway();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { stopVms(); process.exitCode = signal === "SIGINT" ? 130 : 143; setTimeout(() => process.exit(), 1000).unref(); });
}
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 3001 }, (info) => {
  console.log(`Konoha API listening on http://127.0.0.1:${info.port}`);
});
