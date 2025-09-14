import {AnthropicInput, ChatAnthropic} from '@langchain/anthropic';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {BaseChatModelParams} from '@langchain/core/language_models/chat_models';

export class Claude implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    if (!process.env.CLAUDE_MODEL || !process.env.CLAUDE_API_KEY) {
      throw new Error(
        'CLAUDE_MODEL and CLAUDE_API_KEY environment variables must be set',
      );
    }
    const config: AnthropicInput & BaseChatModelParams = {
      model: process.env.CLAUDE_MODEL!,
      apiKey: process.env.CLAUDE_API_KEY,
    };
    if (process.env.CLAUDE_THINKING === 'true') {
      config.thinking = {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        budget_tokens: parseInt(process.env.CLAUDE_THINKING_BUDGET ?? '1024'),
        type: process.env.CLAUDE_THINKING === 'true' ? 'enabled' : 'disabled',
      };
    }
    if (process.env.CLAUDE_TEMPERATURE) {
      config.temperature = parseInt(process.env.CLAUDE_TEMPERATURE);
    }
    return new ChatAnthropic(config);
  }
}
