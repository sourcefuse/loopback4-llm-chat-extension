export type OpenAIInstanceConfig = {
  model: string;
  config?: {
    apiKey?: string;
    baseURL?: string;
    temperature?: number;
  };
};
