import { TOOL_DEFINITIONS } from "../tools/index.js";
import type { ChatMessage, ToolCall } from "../types.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

/** M1-friendly defaults: small context, short answers, unload quickly when idle. */
function ollamaOptions() {
  return {
    num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 2048),
    num_predict: Number(process.env.OLLAMA_NUM_PREDICT ?? 256),
    temperature: Number(process.env.OLLAMA_TEMPERATURE ?? 0.2),
  };
}

const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "30s";

export type ModelTurn =
  | { kind: "message"; content: string }
  | { kind: "tool_calls"; content: string; toolCalls: ToolCall[] };

type OllamaMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: Record<string, unknown> | string;
    };
  }>;
};

const SYSTEM_PROMPT = `You are Latch, a tiny local coding agent used to demonstrate a permission loop.

You can only use these tools: list_dir, read_file, write_file.
All tools operate inside a sandbox folder.
Rules:
- Prefer the fewest tools needed.
- After a tool result answers the user, reply with a short final answer in plain text.
- Do not write or overwrite files unless the user explicitly asks you to write.
- Never imitate transcript text like "Proposed tool call(s):". Use real tool calls instead.`;

function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  const mapped: OllamaMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  // Keep prompt small on M1: only the recent turn window goes to the model.
  const windowSize = Number(process.env.OLLAMA_HISTORY_WINDOW ?? 12);
  const recent = messages.slice(-windowSize);

  for (const message of recent) {
    if (message.role === "tool") {
      mapped.push({
        role: "tool",
        content: message.content,
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      mapped.push({
        role: "assistant",
        content: message.content || "",
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
      });
      continue;
    }

    mapped.push({
      role: message.role,
      content: message.content,
    });
  }

  return mapped;
}

function parseArgs(
  raw: Record<string, unknown> | string | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { raw };
    }
  }
  return raw;
}

function extractJsonToolCalls(content: string): ToolCall[] | null {
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch?.[1]?.trim() ?? content.trim();

  const tryParse = (text: string): ToolCall[] | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      const asCalls = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && "tool_calls" in (parsed as object)
          ? (parsed as { tool_calls: unknown }).tool_calls
          : parsed && typeof parsed === "object" && "name" in (parsed as object)
            ? [parsed]
            : null;
      if (!Array.isArray(asCalls) || asCalls.length === 0) return null;

      return asCalls.map((call, index) => {
        const record = call as {
          id?: string;
          name?: string;
          arguments?: Record<string, unknown>;
          function?: { name?: string; arguments?: Record<string, unknown> };
        };
        const name = record.name ?? record.function?.name;
        const args = record.arguments ?? record.function?.arguments ?? {};
        if (!name) throw new Error("missing tool name");
        return {
          id: record.id ?? `fallback_${Date.now()}_${index}`,
          name,
          arguments: args,
        };
      });
    } catch {
      return null;
    }
  };

  return tryParse(candidate);
}

/** Recover when a small model pastes our UI transcript instead of emitting tools. */
function extractMimickedToolCalls(content: string): ToolCall[] | null {
  const match = content.match(
    /Proposed tool call\(s\):\s*([a-z_]+)\((\{[\s\S]*\})\)\s*$/i,
  );
  if (!match) return null;
  try {
    return [
      {
        id: `mimic_${Date.now()}`,
        name: match[1],
        arguments: JSON.parse(match[2]) as Record<string, unknown>,
      },
    ];
  } catch {
    return null;
  }
}

function coerceToolCallsFromContent(content: string): ToolCall[] | null {
  return extractJsonToolCalls(content) ?? extractMimickedToolCalls(content);
}

async function chatNative(messages: ChatMessage[]): Promise<ModelTurn> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: ollamaOptions(),
      tools: TOOL_DEFINITIONS,
      messages: toOllamaMessages(messages),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    message?: OllamaMessage;
  };

  const message = data.message;
  if (!message) {
    throw new Error("Ollama returned no message");
  }

  const content = message.content ?? "";
  const toolCalls = (message.tool_calls ?? [])
    .map((call, index) => {
      const name = call.function?.name;
      if (!name) return null;
      return {
        id: call.id ?? `tc_${Date.now()}_${index}`,
        name,
        arguments: parseArgs(call.function?.arguments),
      } satisfies ToolCall;
    })
    .filter((call): call is ToolCall => call !== null);

  if (toolCalls.length > 0) {
    return { kind: "tool_calls", content, toolCalls };
  }

  const coerced = coerceToolCallsFromContent(content);
  if (coerced) {
    return { kind: "tool_calls", content, toolCalls: coerced };
  }

  return { kind: "message", content: content || "(empty model response)" };
}

async function chatFallback(messages: ChatMessage[]): Promise<ModelTurn> {
  const toolGuide = `If you need a tool, reply with ONLY JSON like:
{"tool_calls":[{"name":"read_file","arguments":{"path":"notes.txt"}}]}
Otherwise reply with plain text for the user. Do not write files unless asked.`;

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json",
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: ollamaOptions(),
      messages: [
        ...toOllamaMessages(messages),
        { role: "system", content: toolGuide },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama fallback error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { message?: OllamaMessage };
  const content = data.message?.content ?? "";
  const parsedCalls = coerceToolCallsFromContent(content);

  if (parsedCalls && parsedCalls.length > 0) {
    return { kind: "tool_calls", content, toolCalls: parsedCalls };
  }

  try {
    const maybe = JSON.parse(content) as { message?: string; content?: string };
    const text = maybe.message ?? maybe.content;
    if (typeof text === "string" && text.trim()) {
      return { kind: "message", content: text };
    }
  } catch {
    // plain text
  }

  return { kind: "message", content: content || "(empty model response)" };
}

export async function runModelTurn(messages: ChatMessage[]): Promise<ModelTurn> {
  try {
    const native = await chatNative(messages);
    if (native.kind === "tool_calls" || native.content.trim()) {
      return native;
    }
  } catch (error) {
    console.warn(
      "[ollama] native tools failed, using JSON fallback:",
      error instanceof Error ? error.message : error,
    );
  }

  return chatFallback(messages);
}

export function getOllamaConfig() {
  return {
    baseUrl: OLLAMA_BASE_URL,
    model: OLLAMA_MODEL,
    keepAlive: OLLAMA_KEEP_ALIVE,
    options: ollamaOptions(),
  };
}
