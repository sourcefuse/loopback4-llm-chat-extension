import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {ChatOpenAI} from '@langchain/openai';

export class OpenAI implements Provider<LLMProvider> {
  value(): LLMProvider {
    return new ChatOpenAI({
      model: process.env.OPENAI_MODEL,
      temperature: parseInt(process.env.OPENAI_TEMPERATURE ?? '0'),
      configuration: {
        baseURL: process.env.OPENAI_API_BASE_URL,
      },
    });
  }
}
