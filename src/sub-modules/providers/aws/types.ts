import {AmazonBedrockProviderSettings} from '@ai-sdk/amazon-bedrock';

export type BedrockInstanceConfig = {
  model: string;
  providerSettings?: AmazonBedrockProviderSettings;
};
