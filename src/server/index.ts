import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../loop/session.js";
import { getOllamaConfig } from "../ollama/client.js";
import { getSandboxRoot } from "../tools/index.js";
import type { PermissionDecision } from "../types.js";

const store = new SessionStore();
const app = new Hono();
const port = Number(process.env.PORT ?? 8787);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const webDist = path.join(root, "web/dist");

app.use(
  "*",
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ],
  }),
);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    ollama: getOllamaConfig(),
    sandbox: getSandboxRoot(),
  }),
);

app.post("/api/sessions", (c) => {
  const session = store.create();
  return c.json(session.snapshot(), 201);
});

app.get("/api/sessions/:id", (c) => {
  const session = store.get(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session.snapshot());
});

app.get("/api/sessions/:id/events", (c) => {
  const session = store.get(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return streamSSE(c, async (stream) => {
    const unsubscribe = session.subscribe((event) => {
      void stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
    });

    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "{}" });
    }, 15000);

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      });
    });
  });
});

app.post("/api/sessions/:id/messages", async (c) => {
  const session = store.get(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { content?: string };
  if (!body.content || !body.content.trim()) {
    return c.json({ error: "content is required" }, 400);
  }

  void session.handleUserMessage(body.content).catch((error) => {
    console.error("[session]", error);
  });

  return c.json({ ok: true, sessionId: session.id });
});

app.post("/api/sessions/:id/permissions/:requestId", async (c) => {
  const session = store.get(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    decision?: PermissionDecision;
  };
  if (body.decision !== "allow" && body.decision !== "deny") {
    return c.json({ error: 'decision must be "allow" or "deny"' }, 400);
  }

  try {
    session.resolvePermission(c.req.param("requestId"), body.decision);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to resolve permission",
      },
      400,
    );
  }
});

if (existsSync(webDist)) {
  app.use(
    "/*",
    serveStatic({
      root: "./web/dist",
    }),
  );
} else {
  app.get("/", (c) =>
    c.html(
      `<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
        <h1>Latch API</h1>
        <p>API is running on port ${port}.</p>
        <p>Start the web UI with <code>npm run web</code> →
        <a href="http://localhost:5173">http://localhost:5173</a></p>
      </body></html>`,
    ),
  );
}

console.log(`Latch server on http://localhost:${port}`);
console.log(`Ollama: ${JSON.stringify(getOllamaConfig())}`);
console.log(`Sandbox: ${getSandboxRoot()}`);

serve({ fetch: app.fetch, port });
