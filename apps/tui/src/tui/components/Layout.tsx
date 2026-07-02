import React from "react";
import { Box } from "ink";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { StatusBar } from "./StatusBar.js";
import { ChatPane } from "./ChatPane.js";
import { InputBox } from "./InputBox.js";
import { WelcomeScreen } from "./WelcomeScreen.js";
import type { TuiState } from "../state/types.js";

type Props = {
  state: TuiState;
  model: string;
  provider: string;
  version: string;
  onSubmit: (content: string) => void;
  onCancel: () => void;
};

export function Layout({ state, model, provider, version, onSubmit, onCancel }: Props) {
  const { columns, rows } = useTerminalSize();
  const isProcessing = state.status !== "idle";
  const hasMessages = state.messages.length > 0;

  return (
    <Box flexDirection="column" height={rows}>
      <StatusBar
        columns={columns}
        model={model}
        provider={provider}
        cwd={state.cwd || process.cwd()}
        status={state.status}
        version={version}
      />

      {!hasMessages ? (
        <WelcomeScreen
          version={version}
          model={model}
          provider={provider}
          cwd={state.cwd || process.cwd()}
          columns={columns}
        />
      ) : (
        <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
          <ChatPane messages={state.messages} />
        </Box>
      )}

      <InputBox
        onSubmit={onSubmit}
        onCancel={onCancel}
        isProcessing={isProcessing}
        cwd={state.cwd || process.cwd()}
        columns={columns}
      />
    </Box>
  );
}
