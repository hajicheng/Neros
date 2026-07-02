import React from "react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { AgentRuntime } from "@neros/core";
import { loadConfig } from "@neros/core";
import { App } from "../tui/App.js";

function getVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export async function startTui(): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const version = getVersion();

  if (!config.apiKey) {
    console.error(
      "Error: API key not configured.\n\n" +
        "Set NEROS_API_KEY environment variable or add apiKey to config:\n" +
        "  export NEROS_API_KEY=your-api-key\n\n" +
        "Or create ~/.neros/config.json:\n" +
        '  { "apiKey": "your-api-key" }\n',
    );
    process.exit(1);
  }

  const runtime = new AgentRuntime({
    provider: config.provider,
    model: config.model ?? "",
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? "",
    cwd,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
  });

  const { waitUntilExit } = render(React.createElement(App, { runtime, version }), {
    exitOnCtrlC: false,
  });

  process.on("SIGINT", () => {
    runtime.cancel();
  });

  try {
    await waitUntilExit();
  } finally {
    runtime.destroy();
  }
}
