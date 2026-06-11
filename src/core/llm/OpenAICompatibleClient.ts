import type {
  ChatMessage,
  ChatModelClient,
  ChatOptions,
  ModelStreamEvent,
  ProviderConfig,
} from "./types.js";
import { parseSSEStream } from "./stream.js";

export class OpenAICompatibleClient implements ChatModelClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async *chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ModelStreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => this.formatMessage(m)),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options?.tools?.length) {
      body.tools = options.tools;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      yield {
        type: "error",
        error: new Error(`API error ${response.status}: ${text}`),
      };
      return;
    }

    yield* parseSSEStream(response, options?.signal);
  }

  private formatMessage(msg: ChatMessage): Record<string, unknown> {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content,
      };
    }
    return { role: msg.role, content: msg.content };
  }
}
