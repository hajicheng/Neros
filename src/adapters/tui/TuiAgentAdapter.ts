import type { AgentRuntime } from "../../core/agent/AgentRuntime.js";
import type { AgentEvent } from "../../core/events/AgentEvent.js";

export class TuiAgentAdapter {
  private runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    return this.runtime.eventBus.on(handler);
  }

  async sendMessage(content: string): Promise<void> {
    await this.runtime.sendMessage(content);
  }

  cancel(): void {
    this.runtime.cancel();
  }

  destroy(): void {
    this.runtime.destroy();
  }
}
