import type { AgentEvent, AgentStatus, TokenUsage } from "../../core/events/AgentEvent.js";

export type ChatMessageItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  usage?: TokenUsage;
  isStreaming: boolean;
};

export type ToolLogItem = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  input?: unknown;
  output?: unknown;
  error?: string;
  elapsedMs?: number;
};

export type TuiState = {
  sessionId: string | null;
  cwd: string;
  status: AgentStatus;
  messages: ChatMessageItem[];
  toolLogs: ToolLogItem[];
  error: string | null;
};

export const initialState: TuiState = {
  sessionId: null,
  cwd: "",
  status: "idle",
  messages: [],
  toolLogs: [],
  error: null,
};
