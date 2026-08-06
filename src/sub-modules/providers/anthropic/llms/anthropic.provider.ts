import {Provider, ValueOrPromise} from '@loopback/core';
import {createAnthropic} from '@ai-sdk/anthropic';
import {LLMProvider, ModelDefaultSettings} from '../../../../types';

export class Claude implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    if (!process.env.CLAUDE_MODEL || !process.env.CLAUDE_API_KEY) {
      throw new Error(
        'CLAUDE_MODEL and CLAUDE_API_KEY environment variables must be set',
      );
    }
    const provider = createAnthropic({
      apiKey: process.env.CLAUDE_API_KEY,
    });
    const model = provider(process.env.CLAUDE_MODEL) as LLMProvider;
    const defaultSettings: ModelDefaultSettings = {};
    if (process.env.CLAUDE_TEMPERATURE) {
      defaultSettings.temperature = parseInt(process.env.CLAUDE_TEMPERATURE);
    }
    if (process.env.CLAUDE_THINKING === 'true') {
      defaultSettings.providerOptions = {
        anthropic: {
          thinking: {
            type: 'enabled',
            budgetTokens: parseInt(
              process.env.CLAUDE_THINKING_BUDGET ?? '1024',
            ),
          },
        },
      };
    }
    model.defaultSettings = defaultSettings;
    return model;
  }
}
