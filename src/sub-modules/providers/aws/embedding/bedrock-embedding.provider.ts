import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

export class BedrockEmbedding implements Provider<EmbeddingProvider> {
  value(): EmbeddingProvider {
    if (!process.env.BEDROCK_EMBEDDING_MODEL) {
      throw new Error(
        'BEDROCK_EMBEDDING_MODEL environment variable is not set',
      );
    }
    const provider = createAmazonBedrock({
      region: process.env.BEDROCK_AWS_REGION,
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
    });
    return provider.textEmbeddingModel(process.env.BEDROCK_EMBEDDING_MODEL);
  }
}
