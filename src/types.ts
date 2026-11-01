export type LoopPhase =
  | "idle"
  | "observe"
  | "propose"
  | "permission"
  | "act"
  | "done"
  | "denied"
  | "error";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
};

export type PermissionDecision = "allow" | "deny";

export type PermissionRequest = {
  id: string;
  toolCall: ToolCall;
  status: "pending" | "allowed" | "denied";
  createdAt: number;
  resolvedAt?: number;
};

export type TimelineEvent = {
  id: string;
  phase: LoopPhase;
  timestamp: number;
  summary: string;
  detail?: Record<string, unknown>;
};

export type SessionSnapshot = {
  id: string;
  phase: LoopPhase;
  messages: ChatMessage[];
  timeline: TimelineEvent[];
  pendingPermission: PermissionRequest | null;
  createdAt: number;
  updatedAt: number;
};

export type StreamEvent =
  | { type: "snapshot"; data: SessionSnapshot }
  | { type: "timeline"; data: TimelineEvent }
  | { type: "message"; data: ChatMessage }
  | { type: "permission"; data: PermissionRequest }
  | { type: "phase"; data: { phase: LoopPhase } }
  | { type: "error"; data: { message: string } };
