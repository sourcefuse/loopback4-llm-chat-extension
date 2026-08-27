import {Provider} from '@loopback/core';
import {createOpenAI} from '@ai-sdk/openai';
import {LLMProvider} from '../../../../types';
import {OpenAIInstanceConfig} from '../types';

export class OpenAI implements Provider<LLMProvider> {
  static createInstance(config: OpenAIInstanceConfig): LLMProvider {
    const provider = createOpenAI({
      apiKey: config.config?.apiKey,
      baseURL: config.config?.baseURL,
    });
    const model = provider(config.model) as LLMProvider;
    model.defaultSettings = {
      temperature: config.config?.temperature ?? 0,
    };
    return model;
  }
  value(): LLMProvider {
    return OpenAI.createInstance({
      model: process.env.OPENAI_MODEL!,
      config: {
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_API_BASE_URL,
        temperature: Number.parseFloat(process.env.OPENAI_TEMPERATURE ?? '0'),
      },
    });
  }
}
