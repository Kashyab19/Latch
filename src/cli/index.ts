#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type {
  PermissionRequest,
  SessionSnapshot,
  StreamEvent,
} from "../types.js";

const BASE = process.env.LATCH_URL ?? "http://localhost:8787";

async function createSession(): Promise<SessionSnapshot> {
  const res = await fetch(`${BASE}/api/sessions`, { method: "POST" });
  if (!res.ok) throw new Error(`Create session failed: ${res.status}`);
  return res.json() as Promise<SessionSnapshot>;
}

async function sendMessage(sessionId: string, content: string): Promise<void> {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Send failed: ${res.status}`);
  }
}

async function resolvePermission(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
): Promise<void> {
  const res = await fetch(
    `${BASE}/api/sessions/${sessionId}/permissions/${requestId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Permission failed: ${res.status}`);
  }
}

function printPermission(pending: PermissionRequest): void {
  console.log("\n=== PERMISSION GATE ===");
  console.log(`request: ${pending.id}`);
  console.log(`tool:    ${pending.toolCall.name}`);
  console.log(`args:    ${JSON.stringify(pending.toolCall.arguments)}`);
  console.log("Allow [a] / Deny [d]");
}

async function main(): Promise<void> {
  console.log(`Latch CLI → ${BASE}`);
  const session = await createSession();
  console.log(`session ${session.id}`);
  console.log("Type a prompt. Use /quit to exit.\n");

  const state = {
    pending: null as PermissionRequest | null,
    turnBusy: false,
  };

  const rl = readline.createInterface({ input, output });

  // Fetch-based SSE parser (Node has no built-in EventSource here).
  const eventsUrl = `${BASE}/api/sessions/${session.id}/events`;
  void (async () => {
    const res = await fetch(eventsUrl, {
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) {
      console.error("Failed to subscribe to SSE");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        let eventName = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data || eventName === "ping") continue;
        try {
          const event = JSON.parse(data) as StreamEvent;
          if (event.type === "phase") {
            console.log(`· phase → ${event.data.phase}`);
            if (event.data.phase === "done" || event.data.phase === "error") {
              state.turnBusy = false;
            }
          } else if (event.type === "timeline") {
            console.log(`· ${event.data.phase}: ${event.data.summary}`);
          } else if (event.type === "message") {
            const preview = event.data.content.slice(0, 160).replace(/\n/g, " ");
            console.log(`· ${event.data.role}: ${preview}`);
          } else if (event.type === "permission") {
            if (event.data.status === "pending") {
              state.pending = event.data;
              printPermission(event.data);
            } else {
              state.pending = null;
            }
          } else if (event.type === "error") {
            console.error(`! ${event.data.message}`);
            state.turnBusy = false;
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }
  })();

  while (true) {
    const prompt = state.pending
      ? "permission> "
      : state.turnBusy
        ? "loop running…> "
        : "latch> ";
    const line = (await rl.question(prompt)).trim();
    if (!line) continue;
    if (line === "/quit" || line === "/exit") break;

    if (state.pending) {
      const requestId = state.pending.id;
      const key = line.toLowerCase();
      if (key === "a" || key === "allow") {
        await resolvePermission(session.id, requestId, "allow");
        continue;
      }
      if (key === "d" || key === "deny") {
        await resolvePermission(session.id, requestId, "deny");
        continue;
      }
      console.log("Pending permission — type a/allow or d/deny");
      continue;
    }

    if (state.turnBusy) {
      console.log("Wait for the current turn to finish (or resolve permission).");
      continue;
    }

    try {
      state.turnBusy = true;
      await sendMessage(session.id, line);
    } catch (error) {
      state.turnBusy = false;
      console.error(error instanceof Error ? error.message : error);
    }
  }

  rl.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
