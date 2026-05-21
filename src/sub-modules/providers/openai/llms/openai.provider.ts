import {Provider} from '@loopback/core';
import {createOpenAI} from '@ai-sdk/openai';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {OpenAIInstanceConfig} from '../types';

export class OpenAI implements Provider<MastraLanguageModel> {
  static createInstance(config: OpenAIInstanceConfig): MastraLanguageModel {
    const provider = createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      organization: config.organization,
      project: config.project,
    });

    return provider(config.model) as unknown as MastraLanguageModel;
  }

  value(): MastraLanguageModel {
    return OpenAI.createInstance({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_API_BASE_URL,
    });
  }
}
