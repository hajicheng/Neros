import type { Tool, ToolContext } from "./Tool.js";
import type { ChatToolDefinition } from "../llm/types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getEnabled(context: ToolContext): Tool[] {
    return [...this.tools.values()].filter((t) => t.isEnabled(context));
  }

  toToolDefinitions(context: ToolContext): ChatToolDefinition[] {
    return this.getEnabled(context).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersJsonSchema,
      },
    }));
  }

  get size(): number {
    return this.tools.size;
  }
}
