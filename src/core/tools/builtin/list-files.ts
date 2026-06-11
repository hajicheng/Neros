import { z } from "zod";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "../Tool.js";

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  path: z.string().optional().describe("Directory path relative to cwd (default: '.')"),
});

type Input = z.infer<typeof inputSchema>;

export const listFilesTool: Tool<Input, string> = {
  name: "list_files",
  description: "List files in a directory. Uses ripgrep if available.",
  inputSchema,
  parametersJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to cwd (default: '.')" },
    },
  },
  risk: "read",
  isEnabled: () => true,
  async run(input: Input, context: ToolContext): Promise<string> {
    const dir = resolve(context.cwd, input.path ?? ".");
    const rel = relative(context.cwd, dir);
    if (rel.startsWith("..")) {
      throw new Error("Path is outside the workspace");
    }

    try {
      const { stdout } = await execFileAsync("rg", ["--files"], {
        cwd: dir,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      // fallback to recursive readdir
    }

    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => {
        const parent = e.parentPath;
        return relative(dir, join(parent, e.name));
      })
      .join("\n");
  },
};
