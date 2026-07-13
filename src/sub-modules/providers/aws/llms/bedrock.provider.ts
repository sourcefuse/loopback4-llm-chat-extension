import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Bedrock implements Provider<LLMProvider> {
  value(): LLMProvider {
    return this._createdInstance(true);
  }

  protected _createdInstance(_thinking: boolean): LLMProvider {
    if (!process.env.BEDROCK_MODEL) {
      throw new Error(
        'Bedrock model is not specified. Please set the BEDROCK_MODEL environment variable.',
      );
    }
    const provider = createAmazonBedrock({
      region: process.env.BEDROCK_AWS_REGION,
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
    });
    return provider(process.env.BEDROCK_MODEL);
  }
}
