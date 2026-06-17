import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {Provider} from '@loopback/core';
import type {EmbeddingModelV2} from '@ai-sdk/provider';
import {EmbeddingProvider} from '../../../../types';

// v2 (LangGraph) generated retrieval-tuned embeddings via
// GoogleGenerativeAIEmbeddings({ taskType: RETRIEVAL_DOCUMENT, title }). AI-SDK
// exposes taskType ONLY as a per-call provider option (not a constructor arg),
// and Mastra's vector store invokes doEmbed internally — so we wrap the model
// to inject it on every embed, restoring v2 behaviour transparently.
// (`title` has no AI-SDK Google-embedding equivalent, so it is not restored.)
const GEMINI_EMBED_TASK_TYPE = 'RETRIEVAL_DOCUMENT';

export function withGoogleTaskType(
  model: EmbeddingModelV2<string>,
  taskType: string,
): EmbeddingModelV2<string> {
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop !== 'doEmbed') return Reflect.get(target, prop, receiver);
      return (options: Parameters<EmbeddingModelV2<string>['doEmbed']>[0]) =>
        target.doEmbed({
          ...options,
          providerOptions: {
            ...options.providerOptions,
            // a caller-supplied taskType (if any) overrides the default
            google: {taskType, ...(options.providerOptions?.google ?? {})},
          },
        });
    },
  });
}

export class GeminiEmbedding implements Provider<EmbeddingProvider> {
  value(): EmbeddingProvider {
    if (!process.env.GOOGLE_EMBEDDING_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'Google embedding model is not specified. Please set the GOOGLE_EMBEDDING_MODEL environment variable.',
      );
    }
    const provider = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
    });
    const base = provider.textEmbeddingModel(
      process.env.GOOGLE_EMBEDDING_MODEL,
    ) as unknown as EmbeddingModelV2<string>;
    return withGoogleTaskType(
      base,
      GEMINI_EMBED_TASK_TYPE,
    ) as unknown as EmbeddingProvider;
  }
}
