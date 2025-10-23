import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {ChatOpenAI} from '@langchain/openai';
import {OpenAIInstanceConfig} from '../types';

export class OpenAI implements Provider<LLMProvider> {
  static createInstance(config: OpenAIInstanceConfig): ChatOpenAI {
    return new ChatOpenAI({
      model: config.model,
      ...config.config,
    });
  }
  value(): LLMProvider {
    return OpenAI.createInstance({
      model: process.env.OPENAI_MODEL!,
      config: {
        temperature: Number.parseFloat(process.env.OPENAI_TEMPERATURE ?? '0'),
        configuration: {
          baseURL: process.env.OPENAI_API_BASE_URL,
        },
      },
    });
  }
}
