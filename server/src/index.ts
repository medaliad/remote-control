import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

const { httpServer, close } = createApp({
  autopairToken: process.env.AUTOPAIR_TOKEN ?? "",
  allowedOrigins: (process.env.AUTOPAIR_ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  webRoot: process.env.WEB_ROOT ? resolve(process.env.WEB_ROOT) : undefined,
});

httpServer.listen(PORT, "0.0.0.0", () => {
  const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME;
  const base = renderHost ? `https://${renderHost}` : `http://localhost:${PORT}`;
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server]   web       ${base}/`);
  console.log(`[server]   ws relay  ${base.replace(/^http/, "ws")}/ws`);
  console.log(`[server]   agent ch  ${base.replace(/^http/, "ws")}/agent`);
  console.log(`[server]   open-ses  POST ${base}/api/sessions/open`);
  console.log(`[server]   health    ${base}/health`);
  console.log(`[server]   webRoot   ${process.env.WEB_ROOT ?? "(default)"}`);
  if (!(process.env.AUTOPAIR_TOKEN ?? "")) {
    console.warn(`[server]   WARNING: AUTOPAIR_TOKEN unset — /api/sessions/open is open to all callers.`);
  }
});

function gracefulShutdown(signal: string): void {
  console.log(`[server] ${signal} — shutting down`);
  close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (err) => console.error("[server] uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("[server] unhandledRejection:", err));
