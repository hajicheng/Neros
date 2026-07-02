export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallMessage[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolCallMessage = {
  id: string;
  name: string;
  arguments: string;
};

export type ModelStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call.start"; id: string; name: string }
  | { type: "tool_call.delta"; id: string; arguments: string }
  | { type: "tool_call.end"; id: string }
  | { type: "done"; usage?: import("../events/AgentEvent.js").TokenUsage }
  | { type: "error"; error: Error };

export type ProviderConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type ChatModelClient = {
  chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ModelStreamEvent>;
};

export type ChatOptions = {
  tools?: ChatToolDefinition[];
  signal?: AbortSignal;
};

export type ChatToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelProvider = {
  id: string;
  displayName: string;
  defaultBaseUrl: string;
  defaultModel: string;
  createClient(config: ProviderConfig): ChatModelClient;
};
