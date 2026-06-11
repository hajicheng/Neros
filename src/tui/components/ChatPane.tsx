import React from "react";
import { Box, Text } from "ink";
import type { ChatMessageItem } from "../state/types.js";

type Props = {
  messages: ChatMessageItem[];
  height?: number;
};

export function ChatPane({ messages, height }: Props) {
  const visibleMessages = messages.slice(-50);

  return (
    <Box
      flexDirection="column"
      height={height}
      overflow="hidden"
      paddingX={1}
      flexGrow={1}
      flexShrink={1}
    >
      {visibleMessages.length === 0 ? (
        <Text dimColor>  Start a conversation below…</Text>
      ) : (
        visibleMessages.map((msg) => (
          <Box key={msg.id} flexDirection="column" marginBottom={1}>
            <Box>
              {msg.role === "user" ? (
                <Text bold color="green">{"❯ You"}</Text>
              ) : (
                <Text bold color="red">{"◆ Neros"}</Text>
              )}
              {msg.isStreaming && (
                <Text color="cyan">{" ▍"}</Text>
              )}
            </Box>
            <Box paddingLeft={2}>
              <Text wrap="wrap" color={msg.role === "assistant" ? "white" : undefined}>
                {msg.content || (msg.isStreaming ? "…" : "")}
              </Text>
            </Box>
            {msg.usage && (
              <Box paddingLeft={2}>
                <Text dimColor>
                  {`[${msg.usage.totalTokens} tokens]`}
                </Text>
              </Box>
            )}
          </Box>
        ))
      )}
    </Box>
  );
}
