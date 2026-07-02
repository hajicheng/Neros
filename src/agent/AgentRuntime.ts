import { generateId } from "../../shared/ids.js";
import { EventBus } from "../events/EventBus.js";
import { ConversationStore } from "../session/ConversationStore.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentLoop } from "./AgentLoop.js";
import type { AgentConfig } from "./types.js";
import type { ChatModelClient } from "../llm/types.js";
import type { ModelProvider } from "../llm/types.js";
import { deepseekProvider } from "../llm/providers/deepseek.js";
import { openaiCompatibleProvider } from "../llm/providers/openai-compatible.js";
import { readFileTool } from "../tools/builtin/read-file.js";
import { listFilesTool } from "../tools/builtin/list-files.js";
import { grepTool } from "../tools/builtin/grep.js";
import { skillhubTool } from "../tools/builtin/skillhub.js";
import {
  appLaunchTool,
  browserOpenTool,
  browserSearchTool,
  desktopCaptureScreenTool,
  desktopKeyboardTool,
  desktopMouseTool,
  desktopScreenInfoTool,
  desktopWindowTool,
} from "../tools/builtin/desktop-automation.js";

const PROVIDERS: Record<string, ModelProvider> = {
  deepseek: deepseekProvider,
  "openai-compatible": openaiCompatibleProvider,
};

export class AgentRuntime {
  readonly sessionId: string;
  readonly eventBus: EventBus;
  private loop: AgentLoop;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.sessionId = generateId();
    this.config = config;
    this.eventBus = new EventBus();

    const provider = PROVIDERS[config.provider] ?? deepseekProvider;
    const client: ChatModelClient = provider.createClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || provider.defaultBaseUrl,
      model: config.model || provider.defaultModel,
    });

    const tools = new ToolRegistry();
    tools.register(readFileTool);
    tools.register(listFilesTool);
    tools.register(grepTool);
    tools.register(skillhubTool);
    tools.register(desktopScreenInfoTool);
    tools.register(desktopCaptureScreenTool);
    tools.register(desktopMouseTool);
    tools.register(desktopKeyboardTool);
    tools.register(desktopWindowTool);
    tools.register(appLaunchTool);
    tools.register(browserOpenTool);
    tools.register(browserSearchTool);

    const store = new ConversationStore();

    this.loop = new AgentLoop({
      store,
      client,
      tools,
      eventBus: this.eventBus,
      cwd: config.cwd,
      systemPrompt: config.systemPrompt ?? this.defaultSystemPrompt(),
      toolConfig: config.tools,
    });

    this.eventBus.emit({
      type: "session.started",
      sessionId: this.sessionId,
      cwd: config.cwd,
    });
  }

  async sendMessage(content: string): Promise<void> {
    await this.loop.sendMessage(content);
  }

  cancel(): void {
    this.loop.cancel();
  }

  destroy(): void {
    this.eventBus.emit({ type: "session.ended", sessionId: this.sessionId });
    this.eventBus.clear();
  }

  get model(): string {
    const provider = PROVIDERS[this.config.provider] ?? deepseekProvider;
    return this.config.model || provider.defaultModel;
  }

  get providerName(): string {
    const provider = PROVIDERS[this.config.provider] ?? deepseekProvider;
    return provider.displayName;
  }

  private defaultSystemPrompt(): string {
    return `You are Neros, a helpful coding assistant. You have access to tools that can read files, list files, search code, open apps and browsers, inspect the desktop, and control mouse/keyboard input. Use desktop automation carefully: inspect the screen first when coordinates are needed, focus the target window and click the intended input field before sending keyboard text, avoid irreversible actions unless the user asked for them, and be concise and accurate. Current working directory: ${this.config.cwd}`;
  }
}
