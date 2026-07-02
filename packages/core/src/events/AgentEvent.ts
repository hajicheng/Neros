export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type AgentError = {
  code: string;
  message: string;
  details?: unknown;
};

export type AgentEvent =
  | { type: "session.started"; sessionId: string; cwd: string }
  | { type: "user.message"; id: string; content: string }
  | { type: "assistant.message.started"; id: string }
  | { type: "assistant.delta"; id: string; text: string }
  | { type: "assistant.message.completed"; id: string; usage?: TokenUsage }
  | { type: "tool.started"; id: string; name: string; input: unknown }
  | { type: "tool.delta"; id: string; chunk: string }
  | { type: "tool.completed"; id: string; output: unknown; elapsedMs: number }
  | { type: "tool.failed"; id: string; error: AgentError }
  | { type: "agent.status"; status: AgentStatus }
  | { type: "agent.error"; error: AgentError }
  | { type: "session.ended"; sessionId: string };

export type AgentStatus = "idle" | "thinking" | "streaming" | "tooling";
