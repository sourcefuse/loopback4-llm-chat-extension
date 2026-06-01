import {createAnthropic} from '@ai-sdk/anthropic';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Claude implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.CLAUDE_MODEL || !process.env.CLAUDE_API_KEY) {
      throw new Error(
        'CLAUDE_MODEL and CLAUDE_API_KEY environment variables must be set',
      );
    }
    const provider = createAnthropic({apiKey: process.env.CLAUDE_API_KEY});
    return provider(process.env.CLAUDE_MODEL);
  }
}
