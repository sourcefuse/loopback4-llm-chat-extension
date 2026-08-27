import {Provider} from '@loopback/core';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {LLMProvider} from '../../../../types';

export class Gemini implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.GOOGLE_CHAT_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'Google chat model is not specified. Please set the GOOGLE_CHAT_MODEL and GOOGLE_API_KEY environment variables.',
      );
    }

    const provider = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
    });
    return provider(process.env.GOOGLE_CHAT_MODEL) as LLMProvider;
  }
}
