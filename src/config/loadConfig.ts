import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { nerosConfigSchema, type NerosConfig } from "./schema.js";

export async function loadConfig(cwd: string): Promise<NerosConfig> {
  const raw: Record<string, unknown> = {};

  const userConfigPath = resolve(homedir(), ".neros", "config.json");
  const projectConfigPath = resolve(cwd, ".nerosrc.json");

  for (const configPath of [userConfigPath, projectConfigPath]) {
    try {
      const content = await readFile(configPath, "utf-8");
      Object.assign(raw, JSON.parse(content));
    } catch {
      // config file doesn't exist, skip
    }
  }

  if (process.env["NEROS_PROVIDER"]) raw.provider = process.env["NEROS_PROVIDER"];
  if (process.env["NEROS_MODEL"]) raw.model = process.env["NEROS_MODEL"];
  if (process.env["NEROS_BASE_URL"]) raw.baseUrl = process.env["NEROS_BASE_URL"];
  if (process.env["NEROS_API_KEY"]) raw.apiKey = process.env["NEROS_API_KEY"];
  if (!raw.apiKey && process.env["DEEPSEEK_API_KEY"]) raw.apiKey = process.env["DEEPSEEK_API_KEY"];

  return nerosConfigSchema.parse(raw);
}
