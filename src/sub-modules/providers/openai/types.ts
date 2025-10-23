import {ChatOpenAIFields} from '@langchain/openai';

export type OpenAIInstanceConfig = {
  model: string;
  config: ChatOpenAIFields;
};
