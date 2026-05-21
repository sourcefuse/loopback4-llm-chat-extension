import {createAnthropic} from '@ai-sdk/anthropic';
import {Provider, ValueOrPromise} from '@loopback/core';
import type {MastraLanguageModel} from '@mastra/core/agent';

export class Claude implements Provider<MastraLanguageModel> {
  value(): ValueOrPromise<MastraLanguageModel> {
    if (!process.env.CLAUDE_MODEL || !process.env.CLAUDE_API_KEY) {
      throw new Error(
        'CLAUDE_MODEL and CLAUDE_API_KEY environment variables must be set',
      );
    }

    const provider = createAnthropic({
      apiKey: process.env.CLAUDE_API_KEY,
    });

    return provider(process.env.CLAUDE_MODEL) as unknown as MastraLanguageModel;
  }
}
