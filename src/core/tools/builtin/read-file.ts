import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Tool, ToolContext } from "../Tool.js";

const inputSchema = z.object({
  path: z.string().describe("File path relative to the working directory"),
  limit: z.number().optional().describe("Maximum number of lines to read"),
  offset: z.number().optional().describe("Line offset to start reading from (0-based)"),
});

type Input = z.infer<typeof inputSchema>;

export const readFileTool: Tool<Input, string> = {
  name: "read_file",
  description: "Read the contents of a file in the workspace",
  inputSchema,
  parametersJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
      limit: { type: "number", description: "Maximum number of lines to read" },
      offset: { type: "number", description: "Line offset to start reading from (0-based)" },
    },
    required: ["path"],
  },
  risk: "read",
  isEnabled: () => true,
  async run(input: Input, context: ToolContext): Promise<string> {
    const absPath = resolve(context.cwd, input.path);
    const rel = relative(context.cwd, absPath);
    if (rel.startsWith("..")) {
      throw new Error("Path is outside the workspace");
    }

    const content = await readFile(absPath, "utf-8");
    const lines = content.split("\n");

    const offset = input.offset ?? 0;
    const limit = input.limit ?? lines.length;
    const sliced = lines.slice(offset, offset + limit);

    return sliced
      .map((line: string, i: number) => `${String(offset + i + 1).padStart(5)}\t${line}`)
      .join("\n");
  },
};
