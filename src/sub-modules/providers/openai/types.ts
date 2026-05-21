export type OpenAIInstanceConfig = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  settings?: Record<string, unknown>;
};
