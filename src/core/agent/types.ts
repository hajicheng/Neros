export type AgentInput = {
  type: "user_message";
  content: string;
};

export type AgentConfig = {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  cwd: string;
  systemPrompt?: string;
  tools?: Record<string, boolean>;
};
