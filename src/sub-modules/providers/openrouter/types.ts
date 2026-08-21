export type OpenRouterReasoningEffort =
  'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

export type OpenRouterReasoningSummary = 'auto' | 'concise' | 'detailed';

export type OpenRouterProviderRouting = {
  order?: string[];
  only?: string[];
};

export type OpenRouterInstanceConfig = {
  model: string;
  config: {
    apiKey?: string;
    baseURL?: string;
    temperature?: number;
    /** OpenRouter's native reasoning control. */
    reasoningEffort?: OpenRouterReasoningEffort;
    /** OpenAI-only reasoning summary, forwarded for parity (OpenRouter ignores it). */
    reasoningSummary?: OpenRouterReasoningSummary;
    /** Provider routing (order / allow-list). */
    provider?: OpenRouterProviderRouting;
  };
};
