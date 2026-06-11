import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 加载 .env 文件
function loadEnvFile() {
  try {
    const envPath = resolve(process.cwd(), ".env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env 不存在，跳过
  }
}

loadEnvFile();

const args = process.argv.slice(2);

if (args.includes("/version")) {
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(dir, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  console.log(`neros v${pkg.version}`);
  process.exit(0);
}

if (args.includes("/help")) {
  console.log(`
  Neros - TUI Agent powered by OpenAI Compatible API

  Usage:
    neros              Start the TUI
    neros /help        Show this help
    neros /version     Show version

  Environment Variables:
    NEROS_API_KEY      API key for the model provider
    NEROS_BASE_URL     Base URL for the API (default: https://api.deepseek.com)
    NEROS_MODEL        Model name (default: deepseek-v4-pro)
    NEROS_PROVIDER     Provider name (default: deepseek)

  Config Files:
    ~/.neros/config.json       User-level config
    .nerosrc.json              Project-level config
`);
  process.exit(0);
}

const { startTui } = await import("./tui.js");
await startTui();
