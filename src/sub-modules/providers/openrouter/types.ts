import {
  OpenRouterChatSettings,
  OpenRouterProviderSettings,
} from '@openrouter/ai-sdk-provider';

export type OpenRouterInstanceConfig = {
  model: string;
  providerSettings?: OpenRouterProviderSettings;
  settings?: OpenRouterChatSettings;
};
