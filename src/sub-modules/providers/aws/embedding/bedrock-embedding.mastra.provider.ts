import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider} from '@loopback/core';
import type {MastraEmbeddingModel} from '@mastra/core/vector';

/**
 * AI SDK / Mastra-shaped Bedrock embedding provider. Bind to MastraEmbedder.
 */
export class MastraBedrockEmbedding implements Provider<
  MastraEmbeddingModel<string>
> {
  value(): MastraEmbeddingModel<string> {
    if (!process.env.BEDROCK_EMBEDDING_MODEL) {
      throw new Error('BEDROCK_EMBEDDING_MODEL env var required');
    }
    const provider = createAmazonBedrock({
      region: process.env.BEDROCK_AWS_REGION,
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
    });
    return provider.textEmbeddingModel(process.env.BEDROCK_EMBEDDING_MODEL);
  }
}
