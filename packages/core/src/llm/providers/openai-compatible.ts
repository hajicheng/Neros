import type { ModelProvider, ProviderConfig, ChatModelClient } from "../types.js";
import { OpenAICompatibleClient } from "../OpenAICompatibleClient.js";

export const openaiCompatibleProvider: ModelProvider = {
  id: "openai-compatible",
  displayName: "OpenAI Compatible",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4o",
  createClient(config: ProviderConfig): ChatModelClient {
    return new OpenAICompatibleClient(config);
  },
};
