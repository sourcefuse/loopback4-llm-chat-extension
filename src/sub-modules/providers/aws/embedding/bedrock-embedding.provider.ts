import {BedrockEmbeddings} from '@langchain/aws';
import {Provider, ValueOrPromise} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

export class BedrockEmbedding implements Provider<EmbeddingProvider> {
  value(): ValueOrPromise<EmbeddingProvider> {
    if (!process.env.BEDROCK_EMBEDDING_MODEL) {
      throw new Error(
        'BEDROCK_EMBEDDING_MODEL environment variable is not set',
      );
    }
    return new BedrockEmbeddings({
      region: process.env.BEDROCK_AWS_REGION!,
      credentials: {
        accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY!,
      },
      model: process.env.BEDROCK_EMBEDDING_MODEL!,
    });
  }
}
