import { generateId } from "../../shared/ids.js";
import { EventBus } from "../events/EventBus.js";
import { ConversationStore } from "../session/ConversationStore.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ChatModelClient, ChatMessage, ModelStreamEvent, ToolCallMessage } from "../llm/types.js";
import type { ToolContext } from "../tools/Tool.js";
import type { AgentConfig } from "./types.js";

export class AgentLoop {
  private store: ConversationStore;
  private client: ChatModelClient;
  private tools: ToolRegistry;
  private eventBus: EventBus;
  private cwd: string;
  private abortController: AbortController | null = null;
  private toolConfig: Record<string, boolean>;

  constructor(opts: {
    store: ConversationStore;
    client: ChatModelClient;
    tools: ToolRegistry;
    eventBus: EventBus;
    cwd: string;
    systemPrompt?: string;
    toolConfig?: Record<string, boolean>;
  }) {
    this.store = opts.store;
    this.client = opts.client;
    this.tools = opts.tools;
    this.eventBus = opts.eventBus;
    this.cwd = opts.cwd;
    this.toolConfig = opts.toolConfig ?? {};

    if (opts.systemPrompt) {
      this.store.addMessage({ role: "system", content: opts.systemPrompt });
    }
  }

  async sendMessage(content: string): Promise<void> {
    const userMsgId = generateId();
    this.store.addMessage({ role: "user", content });
    this.eventBus.emit({ type: "user.message", id: userMsgId, content });

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      await this.runLoop(signal);
    } finally {
      this.abortController = null;
      this.eventBus.emit({ type: "agent.status", status: "idle" });
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    const maxIterations = 20;
    for (let i = 0; i < maxIterations; i++) {
      if (signal.aborted) break;

      this.eventBus.emit({ type: "agent.status", status: "thinking" });

      const toolContext: ToolContext = { cwd: this.cwd, signal };
      const toolDefs = this.tools.toToolDefinitions(toolContext).filter(
        (t) => this.toolConfig[t.function.name] !== false,
      );

      const messages = this.store.getMessages();
      const assistantId = generateId();
      this.eventBus.emit({ type: "assistant.message.started", id: assistantId });

      let fullText = "";
      const pendingToolCalls = new Map<string, { name: string; args: string }>();
      let hasToolCalls = false;

      this.eventBus.emit({ type: "agent.status", status: "streaming" });

      for await (const event of this.client.chat(messages, {
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        signal,
      })) {
        if (signal.aborted) break;

        switch (event.type) {
          case "delta":
            fullText += event.text;
            this.eventBus.emit({ type: "assistant.delta", id: assistantId, text: event.text });
            break;

          case "tool_call.start":
            hasToolCalls = true;
            pendingToolCalls.set(event.id, { name: event.name, args: "" });
            break;

          case "tool_call.delta": {
            const tc = pendingToolCalls.get(event.id);
            if (tc) tc.args += event.arguments;
            break;
          }

          case "done":
            this.eventBus.emit({
              type: "assistant.message.completed",
              id: assistantId,
              usage: event.usage,
            });
            break;

          case "error":
            this.eventBus.emit({
              type: "agent.error",
              error: { code: "STREAM_ERROR", message: event.error.message },
            });
            return;
        }
      }

      if (!hasToolCalls) {
        this.store.addMessage({ role: "assistant", content: fullText });
        return;
      }

      const toolCallMessages: ToolCallMessage[] = [];
      for (const [id, tc] of pendingToolCalls) {
        toolCallMessages.push({ id, name: tc.name, arguments: tc.args });
      }

      this.store.addMessage({
        role: "assistant",
        content: fullText,
        toolCalls: toolCallMessages,
      });

      this.eventBus.emit({ type: "agent.status", status: "tooling" });

      for (const tc of toolCallMessages) {
        if (signal.aborted) break;
        await this.executeTool(tc, toolContext);
      }
    }
  }

  private async executeTool(
    toolCall: ToolCallMessage,
    context: ToolContext,
  ): Promise<void> {
    const toolEventId = generateId();
    const tool = this.tools.get(toolCall.name);

    if (!tool) {
      const error = { code: "TOOL_NOT_FOUND", message: `Tool '${toolCall.name}' not found` };
      this.eventBus.emit({ type: "tool.failed", id: toolEventId, error });
      this.store.addMessage({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({ error: error.message }),
      });
      return;
    }

    let input: unknown;
    try {
      const rawInput = JSON.parse(toolCall.arguments || "{}");
      input = tool.inputSchema.parse(rawInput);
    } catch (err) {
      const error = {
        code: "TOOL_INPUT_ERROR",
        message: `Invalid input for tool '${toolCall.name}': ${err instanceof Error ? err.message : String(err)}`,
      };
      this.eventBus.emit({ type: "tool.failed", id: toolEventId, error });
      this.store.addMessage({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({ error: error.message }),
      });
      return;
    }

    this.eventBus.emit({
      type: "tool.started",
      id: toolEventId,
      name: toolCall.name,
      input,
    });

    const startTime = Date.now();

    try {
      const result = tool.run(input, context);

      if (Symbol.asyncIterator in (result as object)) {
        let output: unknown = null;
        for await (const event of result as AsyncIterable<import("../tools/Tool.js").ToolEvent>) {
          if (event.type === "delta") {
            this.eventBus.emit({ type: "tool.delta", id: toolEventId, chunk: event.chunk });
          } else if (event.type === "result") {
            output = event.output;
          }
        }
        const elapsedMs = Date.now() - startTime;
        this.eventBus.emit({ type: "tool.completed", id: toolEventId, output, elapsedMs });
        this.store.addMessage({
          role: "tool",
          toolCallId: toolCall.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      } else {
        const output = await (result as Promise<unknown>);
        const elapsedMs = Date.now() - startTime;
        this.eventBus.emit({ type: "tool.completed", id: toolEventId, output, elapsedMs });
        this.store.addMessage({
          role: "tool",
          toolCallId: toolCall.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      }
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      const error = {
        code: "TOOL_EXEC_ERROR",
        message: err instanceof Error ? err.message : String(err),
      };
      this.eventBus.emit({ type: "tool.failed", id: toolEventId, error });
      this.store.addMessage({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({ error: error.message }),
      });
    }
  }
}
