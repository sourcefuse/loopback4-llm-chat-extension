import {ChatOpenRouterInput} from '@langchain/openrouter';

export type OpenRouterInstanceConfig = {
  model: string;
  config: Omit<ChatOpenRouterInput, 'model'>;
};
