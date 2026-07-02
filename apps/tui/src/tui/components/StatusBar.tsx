import React from "react";
import { Box, Text } from "ink";
import type { AgentStatus } from "@neros/core";

type Props = {
  columns: number;
  model: string;
  provider: string;
  cwd: string;
  status: AgentStatus;
  version: string;
};

const STATUS_LABELS: Record<AgentStatus, { label: string; color: string }> = {
  idle: { label: "ready", color: "green" },
  thinking: { label: "thinking…", color: "yellow" },
  streaming: { label: "streaming…", color: "cyan" },
  tooling: { label: "running tool…", color: "magenta" },
};

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

export function StatusBar({ columns, model, provider, cwd, status, version }: Props) {
  const s = STATUS_LABELS[status];
  const shortCwd = cwd.replace(/^\/Users\/[^/]+/, "~");
  const width = Math.max(20, columns || 80);
  const divider = "─".repeat(Math.max(1, width - 1));
  const title = truncate(`Neros v${version}`, width - 1);
  const meta = truncate(
    `model ${provider}/${model}  cwd ${shortCwd}  status ${s.label}`,
    width - 3,
  );

  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      <Box width={width} overflow="hidden">
        <Text bold color="red">{title}</Text>
      </Box>
      <Box paddingLeft={1} width={width} overflow="hidden">
        <Text dimColor>{meta}</Text>
      </Box>
      <Box width={width} overflow="hidden">
        <Text color={s.color}>{divider}</Text>
      </Box>
    </Box>
  );
}
