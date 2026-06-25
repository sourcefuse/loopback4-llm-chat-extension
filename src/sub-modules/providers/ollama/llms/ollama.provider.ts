import {createOpenAI} from '@ai-sdk/openai';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {trimTrailingSlashes} from '../../../../utils';

// Ollama exposes an OpenAI-compatible API at `<base>/v1`. We drive it through
// `@ai-sdk/openai` (AI-SDK v6, spec v2/v3) rather than `ollama-ai-provider`,
// which only ships spec-v1 models that Mastra's AI-SDK v6 runtime rejects
// ("Unsupported model version v1"). This keeps Ollama usable for local dev/
// acceptance runs with no extra dependency and no zod-4 peer conflict.
export class Ollama implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.OLLAMA_MODEL || !process.env.OLLAMA_BASE_URL) {
      throw new Error(
        'OLLAMA_MODEL and OLLAMA_BASE_URL environment variables must be set',
      );
    }
    const provider = createOpenAI({
      baseURL: `${trimTrailingSlashes(process.env.OLLAMA_BASE_URL)}/v1`,
      // Ollama ignores the key but the OpenAI client requires a non-empty one.
      apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
    });
    return provider(process.env.OLLAMA_MODEL) as unknown as LLMProvider;
  }
}
