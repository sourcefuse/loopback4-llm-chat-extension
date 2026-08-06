import {createCerebras} from '@ai-sdk/cerebras';
import {Provider} from '@loopback/core';
import {LLMProvider, ModelDefaultSettings} from '../../../../types';

export class Cerebras implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.CEREBRAS_MODEL || !process.env.CEREBRAS_KEY) {
      throw new Error(
        'CEREBRAS_MODEL and CEREBRAS_KEY environment variable is not set.',
      );
    }
    const provider = createCerebras({
      apiKey: process.env.CEREBRAS_KEY,
    });
    const model = provider(process.env.CEREBRAS_MODEL) as LLMProvider;
    const defaultSettings: ModelDefaultSettings = {
      temperature: parseFloat(process.env.CEREBRAS_TEMPERATURE ?? '0'),
    };
    if (process.env.CEREBRAS_TOP_P) {
      defaultSettings.topP = parseFloat(process.env.CEREBRAS_TOP_P);
    }
    if (process.env.CEREBRAS_MAX_TOKENS) {
      defaultSettings.maxOutputTokens = parseInt(
        process.env.CEREBRAS_MAX_TOKENS,
      );
    }
    model.defaultSettings = defaultSettings;
    return model;
  }
}
