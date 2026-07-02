import { useState, useEffect, useCallback, useRef } from "react";
import type { AgentRuntime } from "@neros/core";
import type { AgentEvent } from "@neros/core";
import { tuiReducer } from "../state/reducer.js";
import { initialState, type TuiState } from "../state/types.js";

export function useAgentSession(runtime: AgentRuntime) {
  const [state, setState] = useState<TuiState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const unsub = runtime.eventBus.on((event: AgentEvent) => {
      setState((prev) => tuiReducer(prev, event));
    });
    return unsub;
  }, [runtime]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;
      try {
        await runtime.sendMessage(content);
      } catch {
        // errors are emitted via event bus
      }
    },
    [runtime],
  );

  const cancel = useCallback(() => {
    runtime.cancel();
  }, [runtime]);

  return { state, sendMessage, cancel };
}
