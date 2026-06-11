export class NerosError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "NerosError";
  }
}

export class ProviderError extends NerosError {
  constructor(message: string, details?: unknown) {
    super(message, "PROVIDER_ERROR", details);
    this.name = "ProviderError";
  }
}

export class ToolError extends NerosError {
  constructor(message: string, details?: unknown) {
    super(message, "TOOL_ERROR", details);
    this.name = "ToolError";
  }
}

export class ConfigError extends NerosError {
  constructor(message: string, details?: unknown) {
    super(message, "CONFIG_ERROR", details);
    this.name = "ConfigError";
  }
}
