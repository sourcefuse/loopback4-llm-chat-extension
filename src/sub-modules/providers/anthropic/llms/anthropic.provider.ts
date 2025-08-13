import {ChatAnthropic} from '@langchain/anthropic';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Claude implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    if (!process.env.CLAUDE_MODEL || !process.env.CLAUDE_API_KEY) {
      throw new Error(
        'CLAUDE_MODEL and CLAUDE_API_KEY environment variables must be set',
      );
    }
    return new ChatAnthropic({
      model: process.env.CLAUDE_MODEL!,
      apiKey: process.env.CLAUDE_API_KEY,
    });
  }
}
