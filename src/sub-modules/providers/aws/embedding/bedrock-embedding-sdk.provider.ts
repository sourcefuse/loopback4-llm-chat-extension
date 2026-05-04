import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider, ValueOrPromise} from '@loopback/core';
import {EmbeddingModel} from 'ai';

/**
 * AI SDK embedding provider for AWS Bedrock (Titan).
 *
 * Environment variables:
 *   - `BEDROCK_EMBEDDING_MODEL` — e.g. `amazon.titan-embed-text-v2:0`
 *   - `BEDROCK_AWS_REGION`
 *   - `BEDROCK_AWS_ACCESS_KEY_ID`
 *   - `BEDROCK_AWS_SECRET_ACCESS_KEY`
 */
export class BedrockEmbeddingSdk implements Provider<EmbeddingModel> {
  value(): ValueOrPromise<EmbeddingModel> {
    const model =
      process.env.BEDROCK_EMBEDDING_MODEL ?? 'amazon.titan-embed-text-v2:0';
    const bedrock = createAmazonBedrock({
      region: process.env.BEDROCK_AWS_REGION ?? 'us-east-1',
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY!,
    });
    return bedrock.embedding(model);
  }
}
