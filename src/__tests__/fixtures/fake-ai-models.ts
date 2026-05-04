/**
 * Creates a minimal fake AI SDK `LanguageModelV3` that returns a preset text
 * response. Use this in unit tests to avoid network calls and module-level
 * stubbing (which doesn't work on non-configurable getters in the `ai` package).
 *
 * @param text        - The text the model should return.
 * @param inputTokens - Simulated input token count (default: 10).
 * @param outputTokens - Simulated output token count (default: 5).
 */
export function createFakeLanguageModel(
  text: string,
  inputTokens = 10,
  outputTokens = 5,
) {
  return {
    specificationVersion: 'v3' as const,
    provider: 'fake',
    modelId: 'fake-model',
    defaultObjectGenerationMode: undefined,
    supportsImageUrls: false,
    supportsStructuredOutputs: false,
    doGenerate: async () => ({
      content: [{type: 'text' as const, text}],
      finishReason: 'stop' as const,
      usage: {
        inputTokens: {total: inputTokens, noCache: inputTokens, cache: 0},
        outputTokens: {total: outputTokens},
        totalTokens: {total: inputTokens + outputTokens},
      },
      warnings: [],
      request: {body: '{}'},
      response: {
        id: 'fake-id',
        timestamp: new Date(),
        modelId: 'fake-model',
        headers: {},
      },
    }),
    doStream: async () => {
      throw new Error('doStream not supported in fake model');
    },
  };
}

/**
 * Creates a fake `LanguageModelV3` that supports `doStream` (for use with
 * `streamText`). Emits the provided text as a single text-delta chunk followed
 * by a finish event with the given token counts.
 */
export function createFakeStreamingLanguageModel(
  text: string,
  inputTokens = 10,
  outputTokens = 5,
) {
  const usage = {
    inputTokens: {total: inputTokens, noCache: inputTokens, cache: 0},
    outputTokens: {total: outputTokens},
    totalTokens: {total: inputTokens + outputTokens},
  };
  return {
    specificationVersion: 'v3' as const,
    provider: 'fake',
    modelId: 'fake-streaming-model',
    defaultObjectGenerationMode: undefined,
    supportsImageUrls: false,
    supportsStructuredOutputs: false,
    doGenerate: async () => ({
      content: [{type: 'text' as const, text}],
      finishReason: 'stop' as const,
      usage,
      warnings: [],
      request: {body: '{}'},
      response: {
        id: 'fake-stream-id',
        timestamp: new Date(),
        modelId: 'fake-streaming-model',
        headers: {},
      },
    }),
    doStream: async () => {
      const parts: object[] = [
        {type: 'text-start', id: 'fake-text-1'},
        {type: 'text-delta', id: 'fake-text-1', delta: text},
        {type: 'text-end', id: 'fake-text-1'},
        {type: 'finish', finishReason: 'stop', usage},
      ];
      let idx = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (idx < parts.length) {
            controller.enqueue(parts[idx++]);
          } else {
            controller.close();
          }
        },
      });
      return {
        stream,
        warnings: [],
        rawCall: {rawPrompt: null, rawSettings: {}},
        request: {body: '{}'},
        response: {
          id: 'fake-stream-id',
          timestamp: new Date(),
          modelId: 'fake-streaming-model',
          headers: {},
        },
      };
    },
  };
}

/**
 * Creates a minimal fake AI SDK `EmbeddingModel` that returns preset embeddings.
 *
 * @param embeddingsPerCall - Array of embedding vectors to return. One per value.
 */
export function createFakeEmbeddingModel(
  embeddingsPerCall: number[][] = [[0.1, 0.2, 0.3]],
) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-embedding-model',
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: false,
    doEmbed: async ({values}: {values: string[]}) => ({
      embeddings: values.map(
        (_, i) => embeddingsPerCall[i % embeddingsPerCall.length],
      ),
      usage: {tokens: values.length},
    }),
  };
}
