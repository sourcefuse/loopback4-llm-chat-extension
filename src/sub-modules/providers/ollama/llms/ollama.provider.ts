import {createOllama} from 'ollama-ai-provider-v2';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Ollama implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    if (!process.env.OLLAMA_MODEL || !process.env.OLLAMA_BASE_URL) {
      throw new Error(
        'OLLAMA_MODEL and OLLAMA_BASE_URL environment variables must be set',
      );
    }
    const provider = createOllama({
      baseURL: process.env.OLLAMA_BASE_URL,
    });
    return provider(process.env.OLLAMA_MODEL) as LLMProvider;
  }
}
