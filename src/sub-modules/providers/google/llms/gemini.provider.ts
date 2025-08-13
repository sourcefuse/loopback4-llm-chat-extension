import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {ChatGoogleGenerativeAI} from '@langchain/google-genai';

export class Gemini implements Provider<LLMProvider> {
  value() {
    if (!process.env.GOOGLE_CHAT_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'Google chat model is not specified. Please set the GOOGLE_CHAT_MODEL and GOOGLE_API_KEY environment variables.',
      );
    }

    return new ChatGoogleGenerativeAI({
      model: process.env.GOOGLE_CHAT_MODEL!,
    });
  }
}
