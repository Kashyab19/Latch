import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  IconArrow,
  IconBot,
  IconCheck,
  IconEye,
  IconFlowDown,
  IconLock,
  IconPause,
  IconSend,
  IconSpark,
  IconTool,
  IconUser,
  IconX,
} from "./icons";
import type {
  ChatMessage,
  LoopPhase,
  PermissionRequest,
  SessionSnapshot,
  StreamEvent,
  TimelineEvent,
  ToolCall,
} from "./types";

const API_BASE = "";
const PRODUCT = "Latch";

const SUGGESTIONS = [
  "Read notes.txt and tell me the secret demo value.",
  "List the sandbox files, then summarize todo.md.",
  "Write report.md with a one-line summary of notes.txt.",
];

const PHASE_ORDER: LoopPhase[] = [
  "observe",
  "propose",
  "permission",
  "act",
  "done",
];

const PHASE_LABEL: Record<LoopPhase, string> = {
  idle: "Ready",
  observe: "Observing",
  propose: "Proposing",
  permission: "Needs permission",
  act: "Running tool",
  done: "Done",
  denied: "Denied",
  error: "Error",
};

type TraceKind = "in" | "model" | "gate" | "tool" | "out" | "wait";

type TraceLine = {
  id: string;
  kind: TraceKind;
  label: string;
  detail?: string;
  active?: boolean;
  waiting?: boolean;
};

async function createSession(): Promise<SessionSnapshot> {
  const res = await fetch(`${API_BASE}/api/sessions`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to create session");
  return res.json();
}

async function sendMessage(sessionId: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to send message");
  }
}

async function resolvePermission(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/sessions/${sessionId}/permissions/${requestId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to resolve permission");
  }
}

function roleMeta(role: ChatMessage["role"], toolName?: string): {
  label: string;
  icon: ReactNode;
} {
  if (role === "user") {
    return { label: "You", icon: <IconUser size={14} /> };
  }
  if (role === "assistant") {
    return { label: PRODUCT, icon: <IconBot size={14} /> };
  }
  if (role === "tool") {
    return {
      label: toolName ? `Tool · ${toolName}` : "Tool",
      icon: <IconTool size={14} />,
    };
  }
  return { label: role, icon: <IconSpark size={14} /> };
}

function shortArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => {
      const text =
        typeof value === "string" ? value : JSON.stringify(value ?? null);
      const clipped = text.length > 36 ? `${text.slice(0, 33)}…` : text;
      return `${key}: ${clipped}`;
    })
    .join(", ");
}

function buildTrace(
  timeline: TimelineEvent[],
  phase: LoopPhase,
  pending: PermissionRequest | null,
  busy: boolean,
): TraceLine[] {
  const lines: TraceLine[] = [];

  for (const event of timeline) {
    const tool = event.detail?.toolCall as ToolCall | undefined;
    const toolName = tool?.name;
    const args = tool ? shortArgs(tool.arguments) : undefined;

    if (event.phase === "observe" && event.summary.startsWith("User")) {
      lines.push({
        id: event.id,
        kind: "in",
        label: "message in",
        detail: "your prompt enters the loop",
      });
    } else if (event.phase === "propose") {
      lines.push({
        id: event.id,
        kind: "model",
        label: "ask model",
        detail: "what should happen next?",
      });
    } else if (event.phase === "permission") {
      lines.push({
        id: event.id,
        kind: "gate",
        label: toolName ? `hold ${toolName}` : "hold tool",
        detail: args || "waiting for allow or deny",
        waiting: pending?.status === "pending",
        active: phase === "permission",
      });
    } else if (event.phase === "act") {
      lines.push({
        id: event.id,
        kind: "tool",
        label: toolName ? `run ${toolName}` : "run tool",
        detail: args || "executing in the sandbox",
      });
    } else if (event.phase === "observe") {
      lines.push({
        id: event.id,
        kind: "model",
        label: "show model the result",
        detail: "loop continues with fresh context",
      });
    } else if (event.phase === "denied") {
      lines.push({
        id: event.id,
        kind: "gate",
        label: toolName ? `deny ${toolName}` : "deny tool",
        detail: "refusal goes back to the model",
      });
    } else if (event.phase === "done") {
      lines.push({
        id: event.id,
        kind: "out",
        label: "reply out",
        detail: "turn complete",
      });
    } else if (event.phase === "error") {
      lines.push({
        id: event.id,
        kind: "out",
        label: "loop error",
        detail: event.summary,
      });
    }
  }

  if (busy && phase === "propose" && !lines.some((l) => l.active)) {
    lines.push({
      id: "live-propose",
      kind: "model",
      label: "ask model",
      detail: "thinking…",
      active: true,
    });
  }

  if (pending) {
    const already = lines.some(
      (line) => line.waiting && line.label.includes(pending.toolCall.name),
    );
    if (!already) {
      lines.push({
        id: `live-${pending.id}`,
        kind: "wait",
        label: `hold ${pending.toolCall.name}`,
        detail: shortArgs(pending.toolCall.arguments) || "paused for you",
        waiting: true,
        active: true,
      });
    }
  }

  return lines.slice(-14);
}

export function App() {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [phase, setPhase] = useState<LoopPhase>("idle");
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const traceRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;

    (async () => {
      try {
        const created = await createSession();
        if (cancelled) return;
        setSession(created);
        setMessages(created.messages);
        setTimeline(created.timeline);
        setPhase(created.phase);
        setPending(created.pendingPermission);
        setConnected(true);

        source = new EventSource(`${API_BASE}/api/sessions/${created.id}/events`);

        const handle = (raw: MessageEvent<string>) => {
          const event = JSON.parse(raw.data) as StreamEvent;
          if (event.type === "snapshot") {
            setSession(event.data);
            setMessages(event.data.messages);
            setTimeline(event.data.timeline);
            setPhase(event.data.phase);
            setPending(event.data.pendingPermission);
          } else if (event.type === "message") {
            setMessages((prev) =>
              prev.some((m) => m.id === event.data.id)
                ? prev
                : [...prev, event.data],
            );
          } else if (event.type === "timeline") {
            setTimeline((prev) =>
              prev.some((e) => e.id === event.data.id)
                ? prev
                : [...prev, event.data],
            );
          } else if (event.type === "phase") {
            setPhase(event.data.phase);
            if (event.data.phase === "done" || event.data.phase === "error") {
              setBusy(false);
            }
          } else if (event.type === "permission") {
            setPending(event.data.status === "pending" ? event.data : null);
          } else if (event.type === "error") {
            setError(event.data.message);
            setBusy(false);
          }
        };

        for (const name of [
          "snapshot",
          "message",
          "timeline",
          "phase",
          "permission",
          "error",
        ]) {
          source.addEventListener(name, handle as EventListener);
        }

        source.onerror = () => setConnected(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending, phase]);

  useEffect(() => {
    if (pending) allowRef.current?.focus();
    else if (!busy) composerRef.current?.focus();
  }, [pending, busy]);

  const trace = useMemo(
    () => buildTrace(timeline, phase, pending, busy),
    [timeline, phase, pending, busy],
  );

  useEffect(() => {
    const el = traceRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [trace]);

  const onSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!session || !draft.trim() || busy || pending) return;
    setError(null);
    setBusy(true);
    try {
      await sendMessage(session.id, draft.trim());
      setDraft("");
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSuggestion = (text: string) => {
    setDraft(text);
    composerRef.current?.focus();
  };

  const onDecision = async (decision: "allow" | "deny") => {
    if (!session || !pending) return;
    setError(null);
    try {
      await resolvePermission(session.id, pending.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSubmit();
    }
  };

  const phaseHint = useMemo(() => {
    if (phase === "permission") {
      return "A tool is waiting for your decision before it can run.";
    }
    if (phase === "propose") return "Choosing the next action…";
    if (phase === "act") return "Running the allowed tool…";
    if (phase === "observe") return "Updating context from the latest result…";
    if (phase === "done") return "Turn finished. Ask another question anytime.";
    if (phase === "denied") {
      return "That tool was denied. The agent saw the refusal.";
    }
    if (phase === "error") return "Something went wrong in the loop.";
    return `Ask ${PRODUCT} to read or write a sandbox file.`;
  }, [phase]);

  const locked = Boolean(pending);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <div className="mark" aria-hidden="true">
            <IconLock size={15} />
          </div>
          <div>
            <h1>{PRODUCT}</h1>
            <p>Local agent with a visible permission loop</p>
          </div>
        </div>
        <div className="topbar-status">
          <span
            className={`live-dot ${connected ? "on" : "off"}`}
            aria-hidden="true"
          />
          <span className="sr-only">
            {connected ? "Connected" : "Disconnected"}
          </span>
          <span className={`status-chip phase-${phase}`}>
            {PHASE_LABEL[phase]}
          </span>
          {session ? (
            <span className="session-id" title={session.id}>
              {session.id.replace("sess_", "")}
            </span>
          ) : null}
        </div>
      </header>

      <div className="workspace">
        <section className="thread-pane" aria-label="Conversation">
          <div className="thread-head">
            <div>
              <h2>Conversation</h2>
              <p>{phaseHint}</p>
            </div>
            <ol className="loop-strip" aria-label="Loop phases">
              {PHASE_ORDER.map((item) => (
                <li
                  key={item}
                  className={phase === item ? "active" : ""}
                  aria-current={phase === item ? "step" : undefined}
                >
                  {item}
                </li>
              ))}
            </ol>
          </div>

          <div className="thread" ref={threadRef} aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon" aria-hidden="true">
                  <IconLock size={22} />
                </div>
                <h3>Start with something the agent must ask for</h3>
                <p>
                  {PRODUCT} pauses before every tool call. You allow or deny —
                  then the loop continues.
                </p>
                <div className="suggestions">
                  {SUGGESTIONS.map((text) => (
                    <button
                      key={text}
                      type="button"
                      className="suggestion"
                      onClick={() => onSuggestion(text)}
                    >
                      <IconSpark size={14} />
                      <span>{text}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => {
                const meta = roleMeta(message.role, message.toolName);
                return (
                  <article
                    key={message.id}
                    className={`turn turn-${message.role}`}
                  >
                    <header>
                      <span className="turn-who">
                        <span className="turn-icon">{meta.icon}</span>
                        {meta.label}
                      </span>
                      <time
                        dateTime={new Date(message.timestamp).toISOString()}
                      >
                        {new Date(message.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </header>
                    <div className="turn-body">{message.content}</div>
                  </article>
                );
              })
            )}

            {busy && !pending && phase !== "done" ? (
              <div className="thinking" aria-busy="true">
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {PHASE_LABEL[phase]}
              </div>
            ) : null}
          </div>

          {pending ? (
            <div
              className="permission-sheet"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="permission-title"
              aria-describedby="permission-desc"
            >
              <div className="permission-copy">
                <p className="permission-kicker">
                  <IconLock size={12} />
                  Permission required
                </p>
                <h3 id="permission-title">
                  <IconTool size={16} />
                  {pending.toolCall.name}
                </h3>
                <p id="permission-desc">
                  This tool will not run until you allow it. Deny to refuse and
                  continue the turn with a denial.
                </p>
                <dl className="arg-list">
                  {Object.entries(pending.toolCall.arguments).map(
                    ([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>
                          <code>
                            {typeof value === "string"
                              ? value
                              : JSON.stringify(value)}
                          </code>
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              </div>
              <div className="permission-actions">
                <button
                  type="button"
                  className="btn btn-deny"
                  onClick={() => onDecision("deny")}
                >
                  <IconX size={15} />
                  Deny
                </button>
                <button
                  ref={allowRef}
                  type="button"
                  className="btn btn-allow"
                  onClick={() => onDecision("allow")}
                >
                  <IconCheck size={15} />
                  Allow once
                </button>
              </div>
            </div>
          ) : null}

          <form className="composer" onSubmit={onSubmit}>
            <label className="sr-only" htmlFor="composer">
              Message
            </label>
            <textarea
              id="composer"
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
              rows={2}
              placeholder={
                pending
                  ? "Resolve the permission above to continue…"
                  : `Message ${PRODUCT}… (Enter to send)`
              }
              disabled={locked}
              readOnly={locked}
            />
            <button
              type="submit"
              className="btn btn-send"
              disabled={!session || busy || locked || !draft.trim()}
              aria-label="Send message"
            >
              {busy && !pending ? (
                "Working…"
              ) : (
                <>
                  <IconSend size={15} />
                  Send
                </>
              )}
            </button>
          </form>
          {error ? (
            <p className="error-banner" role="alert">
              {error}
            </p>
          ) : null}
        </section>

        <aside className="side-pane" aria-label="Under the hood">
          <div className="side-head">
            <h2>Under the hood</h2>
            <p>What {PRODUCT} is doing, step by step</p>
          </div>

          <div className="trace-legend" aria-hidden="true">
            <span>
              <IconArrow size={12} /> call
            </span>
            <span>
              <IconPause size={12} /> wait
            </span>
            <span>
              <IconEye size={12} /> result
            </span>
          </div>

          <ul className="call-trace" ref={traceRef}>
            {trace.length === 0 ? (
              <li className="trace-empty">
                Send a message to watch the loop open here — message in, model
                thinks, latch holds, tool runs, reply out.
              </li>
            ) : (
              trace.map((line, index) => (
                <li
                  key={line.id}
                  className={`trace-line kind-${line.kind} ${line.active ? "active" : ""} ${line.waiting ? "waiting" : ""}`}
                >
                  <div className="trace-rail" aria-hidden="true">
                    <span className="trace-glyph">
                      {line.waiting || line.kind === "wait" ? (
                        <IconPause size={13} />
                      ) : line.kind === "gate" ? (
                        <IconLock size={13} />
                      ) : line.kind === "tool" ? (
                        <IconTool size={13} />
                      ) : line.kind === "in" || line.kind === "out" ? (
                        <IconArrow size={13} />
                      ) : line.kind === "model" &&
                        line.label.includes("result") ? (
                        <IconEye size={13} />
                      ) : (
                        <IconBot size={13} />
                      )}
                    </span>
                    {index < trace.length - 1 ? (
                      <span className="trace-flow">
                        <span className="trace-flow-line" />
                        <IconFlowDown size={11} className="trace-flow-arrow" />
                      </span>
                    ) : null}
                  </div>
                  <div>
                    <code>{line.label}</code>
                    {line.detail ? <p>{line.detail}</p> : null}
                  </div>
                </li>
              ))
            )}
          </ul>

          <div className="side-foot">
            <div className={`now-pill phase-${phase}`}>
              {phase === "permission" ? <IconLock size={13} /> : <IconSpark size={13} />}
              Now: {PHASE_LABEL[phase]}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
