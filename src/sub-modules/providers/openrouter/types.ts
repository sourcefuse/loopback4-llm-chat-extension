export type OpenRouterReasoningEffort =
  'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

export type OpenRouterReasoningSummary = 'auto' | 'concise' | 'detailed';

export interface CreateOpenRouterModelOptions {
  temperature?: string;
  reasoningEffort?: OpenRouterReasoningEffort;
  reasoningSummary?: OpenRouterReasoningSummary;
  provider?: {order?: string[]; only?: string[]};
}

export type OpenRouterInstanceConfig = {
  model: string;
  config: {
    apiKey?: string;
    baseURL?: string;
    temperature?: number;
    provider?: {order?: string[]; only?: string[]};
    reasoning?: {
      effort?: OpenRouterReasoningEffort;
      summary?: OpenRouterReasoningSummary;
    };
  };
};
