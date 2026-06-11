import type { ModelStreamEvent } from "./types.js";

export async function* parseSSEStream(
  response: Response,
  signal?: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  const body = response.body;
  if (!body) {
    yield { type: "error", error: new Error("No response body") };
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed === "data: [DONE]") {
          return;
        }

        if (trimmed.startsWith("data: ")) {
          const json = trimmed.slice(6);
          try {
            const chunk = JSON.parse(json) as SSEChunk;
            yield* processChunk(chunk);
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

type SSEChunk = {
  id?: string;
  choices?: Array<{
    index: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

function* processChunk(chunk: SSEChunk): Iterable<ModelStreamEvent> {
  const choice = chunk.choices?.[0];
  if (!choice) {
    if (chunk.usage) {
      yield {
        type: "done",
        usage: {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        },
      };
    }
    return;
  }

  const delta = choice.delta;
  if (!delta) return;

  if (delta.content) {
    yield { type: "delta", text: delta.content };
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id && tc.function?.name) {
        yield { type: "tool_call.start", id: tc.id, name: tc.function.name };
      }
      if (tc.function?.arguments) {
        yield {
          type: "tool_call.delta",
          id: tc.id ?? "",
          arguments: tc.function.arguments,
        };
      }
    }
  }

  if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
    if (chunk.usage) {
      yield {
        type: "done",
        usage: {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        },
      };
    }
  }
}
