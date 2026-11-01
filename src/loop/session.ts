import { randomUUID } from "node:crypto";
import { runModelTurn } from "../ollama/client.js";
import { executeTool } from "../tools/index.js";
import type {
  ChatMessage,
  LoopPhase,
  PermissionDecision,
  PermissionRequest,
  SessionSnapshot,
  StreamEvent,
  TimelineEvent,
  ToolCall,
} from "../types.js";

type Listener = (event: StreamEvent) => void;

function id(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export class Session {
  readonly id: string;
  readonly createdAt: number;
  private updatedAt: number;
  private phase: LoopPhase = "idle";
  private messages: ChatMessage[] = [];
  private timeline: TimelineEvent[] = [];
  private pendingPermission: PermissionRequest | null = null;
  private permissionWaiter: {
    resolve: (decision: PermissionDecision) => void;
  } | null = null;
  private listeners = new Set<Listener>();
  private running = false;

  constructor(sessionId = id("sess")) {
    this.id = sessionId;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ type: "snapshot", data: this.snapshot() });
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      phase: this.phase,
      messages: [...this.messages],
      timeline: [...this.timeline],
      pendingPermission: this.pendingPermission
        ? { ...this.pendingPermission, toolCall: { ...this.pendingPermission.toolCall } }
        : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  async handleUserMessage(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("Message cannot be empty");
    }
    if (this.running) {
      throw new Error("Session is already processing a turn");
    }
    if (this.pendingPermission) {
      throw new Error("Resolve the pending permission before sending another message");
    }

    this.running = true;
    try {
      this.pushMessage({
        id: id("msg"),
        role: "user",
        content: trimmed,
        timestamp: Date.now(),
      });
      this.emitPhase("observe", "User message observed", { content: trimmed });
      await this.runAgentLoop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitPhase("error", message);
      this.emit({ type: "error", data: { message } });
      this.pushMessage({
        id: id("msg"),
        role: "assistant",
        content: `Loop error: ${message}`,
        timestamp: Date.now(),
      });
    } finally {
      this.running = false;
    }
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    if (!this.pendingPermission || this.pendingPermission.id !== requestId) {
      throw new Error("No matching pending permission request");
    }
    if (!this.permissionWaiter) {
      throw new Error("Permission waiter missing");
    }

    this.pendingPermission = {
      ...this.pendingPermission,
      status: decision === "allow" ? "allowed" : "denied",
      resolvedAt: Date.now(),
    };
    this.emit({ type: "permission", data: this.pendingPermission });
    this.permissionWaiter.resolve(decision);
    this.permissionWaiter = null;
  }

  private async runAgentLoop(): Promise<void> {
    const maxSteps = Number(
      process.env.LATCH_MAX_STEPS ?? process.env.GATELOOP_MAX_STEPS ?? 5,
    );

    for (let step = 0; step < maxSteps; step += 1) {
      this.emitPhase("propose", "Asking model for next action");
      const turn = await runModelTurn(this.messages);

      if (turn.kind === "message") {
        this.pushMessage({
          id: id("msg"),
          role: "assistant",
          content: turn.content,
          timestamp: Date.now(),
        });
        this.emitPhase("done", "Assistant finished without more tools");
        return;
      }

      // Keep tool calls structured so the model does not imitate UI transcript text.
      const intentSummary = turn.toolCalls
        .map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
        .join("; ");
      this.pushMessage({
        id: id("msg"),
        role: "assistant",
        content: turn.content?.trim() ? turn.content : `Calling ${intentSummary}`,
        toolCalls: turn.toolCalls,
        timestamp: Date.now(),
      });

      for (const toolCall of turn.toolCalls) {
        const decision = await this.requestPermission(toolCall);
        if (decision === "deny") {
          this.emitPhase("denied", `Denied ${toolCall.name}`, {
            toolCall,
          });
          this.pushMessage({
            id: id("msg"),
            role: "tool",
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            content: `Permission denied for ${toolCall.name}. Do not retry the same call unless the user asks.`,
            timestamp: Date.now(),
          });
          this.emitPhase("observe", "Denial observed by model");
          continue;
        }

        this.emitPhase("act", `Running ${toolCall.name}`, { toolCall });
        let result: string;
        try {
          result = await executeTool(toolCall.name, toolCall.arguments);
        } catch (error) {
          result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }

        this.pushMessage({
          id: id("msg"),
          role: "tool",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          content: result,
          timestamp: Date.now(),
        });
        this.emitPhase("observe", `Observed result from ${toolCall.name}`, {
          preview: result.slice(0, 240),
        });
      }
    }

    this.pushMessage({
      id: id("msg"),
      role: "assistant",
      content: "Stopped after the maximum number of tool steps for this demo.",
      timestamp: Date.now(),
    });
    this.emitPhase("done", "Hit max step limit");
  }

  private requestPermission(toolCall: ToolCall): Promise<PermissionDecision> {
    const request: PermissionRequest = {
      id: id("perm"),
      toolCall,
      status: "pending",
      createdAt: Date.now(),
    };
    this.pendingPermission = request;
    this.emitPhase("permission", `Waiting for permission: ${toolCall.name}`, {
      requestId: request.id,
      toolCall,
    });
    this.emit({ type: "permission", data: request });

    return new Promise<PermissionDecision>((resolve) => {
      this.permissionWaiter = {
        resolve: (decision) => {
          this.pendingPermission = null;
          resolve(decision);
        },
      };
    });
  }

  private pushMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.touch();
    this.emit({ type: "message", data: message });
  }

  private emitPhase(
    phase: LoopPhase,
    summary: string,
    detail?: Record<string, unknown>,
  ): void {
    this.phase = phase;
    this.touch();
    const event: TimelineEvent = {
      id: id("evt"),
      phase,
      timestamp: Date.now(),
      summary,
      detail,
    };
    this.timeline.push(event);
    this.emit({ type: "phase", data: { phase } });
    this.emit({ type: "timeline", data: event });
  }

  private emit(event: StreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private touch(): void {
    this.updatedAt = Date.now();
  }
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(): Session {
    const session = new Session();
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}
