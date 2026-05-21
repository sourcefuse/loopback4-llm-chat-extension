import {embed, embedMany} from 'ai';
import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider, ValueOrPromise} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

type AiEmbeddingModel = Parameters<typeof embed>[0]['model'];

export class BedrockEmbedding implements Provider<EmbeddingProvider> {
  value(): ValueOrPromise<EmbeddingProvider> {
    if (!process.env.BEDROCK_EMBEDDING_MODEL) {
      throw new Error(
        'BEDROCK_EMBEDDING_MODEL environment variable is not set',
      );
    }

    if (!process.env.BEDROCK_AWS_REGION) {
      throw new Error(
        'BEDROCK_AWS_REGION environment variable is not set for Bedrock embedding provider.',
      );
    }

    const provider = createAmazonBedrock({
      region: process.env.BEDROCK_AWS_REGION,
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.BEDROCK_AWS_SESSION_TOKEN,
    });

    const model = provider.embeddingModel(
      process.env.BEDROCK_EMBEDDING_MODEL,
    ) as unknown as AiEmbeddingModel;

    return {
      embedDocuments: async (texts: string[]) => {
        if (texts.length === 0) {
          return [];
        }
        const result = await embedMany({
          model,
          values: texts,
        });
        return result.embeddings.map(embedding => Array.from(embedding));
      },
      embedQuery: async (text: string) => {
        const result = await embed({
          model,
          value: text,
        });
        return Array.from(result.embedding);
      },
    } as EmbeddingProvider;
  }
}
