import React from "react";
import { useAgentSession } from "./hooks/useAgentSession.js";
import { Layout } from "./components/Layout.js";
import type { AgentRuntime } from "../core/agent/AgentRuntime.js";

type Props = {
  runtime: AgentRuntime;
  version: string;
};

export function App({ runtime, version }: Props) {
  const { state, sendMessage, cancel } = useAgentSession(runtime);

  return (
    <Layout
      state={state}
      model={runtime.model}
      provider={runtime.providerName}
      version={version}
      onSubmit={sendMessage}
      onCancel={cancel}
    />
  );
}
