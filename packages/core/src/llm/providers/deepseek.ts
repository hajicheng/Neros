import type { ModelProvider, ProviderConfig, ChatModelClient } from "../types.js";
import { OpenAICompatibleClient } from "../OpenAICompatibleClient.js";

export const deepseekProvider: ModelProvider = {
  id: "deepseek",
  displayName: "DeepSeek",
  defaultBaseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-pro",
  createClient(config: ProviderConfig): ChatModelClient {
    return new OpenAICompatibleClient(config);
  },
};
