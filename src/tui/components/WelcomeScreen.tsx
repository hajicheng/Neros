import React from "react";
import { Box, Text } from "ink";

type Props = {
  version: string;
  model: string;
  provider: string;
  cwd: string;
  columns: number;
};

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

export function WelcomeScreen({ version, model, provider, cwd, columns }: Props) {
  const shortCwd = cwd.replace(/^\/Users\/[^/]+/, "~");
  const width = Math.max(20, columns || 80);
  const lineWidth = Math.max(10, width - 4);

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" paddingX={1} paddingY={1}>
      <Text color="red" bold>{truncate("Welcome to Neros", lineWidth)}</Text>
      <Text dimColor>{truncate(`v${version}  ${provider}/${model}`, lineWidth)}</Text>
      <Text dimColor>{truncate(`cwd ${shortCwd}`, lineWidth)}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{truncate("Type a message and press Enter to chat.", lineWidth)}</Text>
        <Text dimColor>{truncate("Press / for commands, ? for shortcuts.", lineWidth)}</Text>
        <Text dimColor>{truncate("Esc pauses a run, Ctrl+C interrupts it.", lineWidth)}</Text>
      </Box>
    </Box>
  );
}
