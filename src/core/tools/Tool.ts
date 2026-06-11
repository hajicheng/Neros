import type { z } from "zod";

export type ToolRisk = "read" | "write" | "exec" | "network";

export type ToolContext = {
  cwd: string;
  signal?: AbortSignal;
};

export type ToolEvent =
  | { type: "delta"; chunk: string }
  | { type: "result"; output: unknown };

export type Tool<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  parametersJsonSchema: Record<string, unknown>;
  risk: ToolRisk;
  isEnabled(context: ToolContext): boolean;
  run(input: Input, context: ToolContext): AsyncIterable<ToolEvent> | Promise<Output>;
};
