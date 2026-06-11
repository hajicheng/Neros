import type { AgentEvent } from "../../core/events/AgentEvent.js";
import type { TuiState } from "./types.js";

export function tuiReducer(state: TuiState, event: AgentEvent): TuiState {
  switch (event.type) {
    case "session.started":
      return { ...state, sessionId: event.sessionId, cwd: event.cwd };

    case "user.message":
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: event.id, role: "user", content: event.content, isStreaming: false },
        ],
        error: null,
      };

    case "assistant.message.started":
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: event.id, role: "assistant", content: "", isStreaming: true },
        ],
      };

    case "assistant.delta": {
      const messages = state.messages.map((m) =>
        m.id === event.id ? { ...m, content: m.content + event.text } : m,
      );
      return { ...state, messages };
    }

    case "assistant.message.completed": {
      const messages = state.messages.map((m) =>
        m.id === event.id ? { ...m, isStreaming: false, usage: event.usage } : m,
      );
      return { ...state, messages };
    }

    case "tool.started":
      return {
        ...state,
        toolLogs: [
          ...state.toolLogs,
          { id: event.id, name: event.name, status: "running", input: event.input },
        ],
      };

    case "tool.completed": {
      const toolLogs = state.toolLogs.map((t) =>
        t.id === event.id
          ? { ...t, status: "completed" as const, output: event.output, elapsedMs: event.elapsedMs }
          : t,
      );
      return { ...state, toolLogs };
    }

    case "tool.failed": {
      const toolLogs = state.toolLogs.map((t) =>
        t.id === event.id
          ? { ...t, status: "failed" as const, error: event.error.message }
          : t,
      );
      return { ...state, toolLogs };
    }

    case "agent.status":
      return { ...state, status: event.status };

    case "agent.error":
      return { ...state, error: event.error.message };

    case "session.ended":
      return { ...state, status: "idle" };

    default:
      return state;
  }
}
