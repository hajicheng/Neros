import { z } from "zod";
import { execFile } from "node:child_process";
import { resolve, relative } from "node:path";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "../Tool.js";

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  pattern: z.string().describe("Search pattern (regex)"),
  path: z.string().optional().describe("Directory to search in, relative to cwd (default: '.')"),
  include: z.string().optional().describe("File glob to include (e.g., '*.ts')"),
});

type Input = z.infer<typeof inputSchema>;

export const grepTool: Tool<Input, string> = {
  name: "grep",
  description: "Search for a pattern in files. Uses ripgrep if available.",
  inputSchema,
  parametersJsonSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (regex)" },
      path: { type: "string", description: "Directory to search in, relative to cwd (default: '.')" },
      include: { type: "string", description: "File glob to include (e.g., '*.ts')" },
    },
    required: ["pattern"],
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
      const args = ["--line-number", "--no-heading"];
      if (input.include) {
        args.push("--glob", input.include);
      }
      args.push(input.pattern);

      const { stdout } = await execFileAsync("rg", args, {
        cwd: dir,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim() || "No matches found.";
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === 1) {
        return "No matches found.";
      }
    }

    try {
      const args = ["-rn"];
      if (input.include) {
        args.push("--include", input.include);
      }
      args.push(input.pattern, ".");

      const { stdout } = await execFileAsync("grep", args, {
        cwd: dir,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim() || "No matches found.";
    } catch {
      return "No matches found.";
    }
  },
};
