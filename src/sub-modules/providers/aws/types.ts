import {ChatBedrockConverseInput} from '@langchain/aws';

export type BedrockInstanceConfig = {
  model: string;
  config?: Partial<ChatBedrockConverseInput>;
};
