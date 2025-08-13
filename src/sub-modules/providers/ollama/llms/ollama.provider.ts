import {ChatOllama} from '@langchain/ollama';
import {Provider, ValueOrPromise} from '@loopback/core';

export class Ollama implements Provider<ChatOllama> {
  value(): ValueOrPromise<ChatOllama> {
    if (!process.env.OLLAMA_MODEL || !process.env.OLLAMA_BASE_URL) {
      throw new Error(
        'OLLAMA_MODEL and OLLAMA_BASE_URL environment variables must be set',
      );
    }
    return new ChatOllama({
      model: process.env.OLLAMA_MODEL,
      baseUrl: process.env.OLLAMA_BASE_URL,
    });
  }
}
