import {createOllama} from 'ollama-ai-provider';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Ollama implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    const baseURL = process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_URL;

    if (!process.env.OLLAMA_MODEL || !baseURL) {
      throw new Error(
        'OLLAMA_MODEL and OLLAMA_BASE_URL (or OLLAMA_URL) environment variables must be set',
      );
    }

    const provider = createOllama({
      baseURL,
    });

    return provider(process.env.OLLAMA_MODEL) as unknown as LLMProvider;
  }
}
