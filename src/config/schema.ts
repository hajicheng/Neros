import { z } from "zod";

export const nerosConfigSchema = z.object({
  provider: z.string().default("deepseek"),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  tools: z
    .record(z.string(), z.boolean())
    .default({ read_file: true, list_files: true, grep: true, skillhub: true, shell: false }),
  ui: z
    .object({
      toolLogPane: z.boolean().default(true),
      theme: z.string().default("system"),
    })
    .default({ toolLogPane: true, theme: "system" }),
  systemPrompt: z.string().optional(),
});

export type NerosConfig = z.infer<typeof nerosConfigSchema>;
