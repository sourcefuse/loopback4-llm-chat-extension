import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider, ModelDefaultSettings} from '../../../../types';
import {BedrockInstanceConfig} from '../types';

export class Bedrock implements Provider<LLMProvider> {
  static createInstance(config: BedrockInstanceConfig): LLMProvider {
    const provider = createAmazonBedrock({
      region: config.config?.region,
      accessKeyId: config.config?.accessKeyId,
      secretAccessKey: config.config?.secretAccessKey,
    });
    const model = provider(config.model) as LLMProvider;
    model.getFile = (file: Express.Multer.File) => ({
      type: 'file',
      mediaType: 'application/pdf',
      data: file.buffer?.toString('base64') ?? '',
    });
    if (config.config?.defaultSettings) {
      model.defaultSettings = config.config.defaultSettings;
    }
    return model;
  }
  value(): ValueOrPromise<LLMProvider> {
    return this._createdInstance(true);
  }

  protected _createdInstance(thinking: boolean): LLMProvider {
    if (!process.env.BEDROCK_MODEL) {
      throw new Error(
        'Bedrock model is not specified. Please set the BEDROCK_MODEL environment variable.',
      );
    }
    const defaultSettings: ModelDefaultSettings = {};
    if (process.env.CLAUDE_THINKING && thinking) {
      defaultSettings.providerOptions = {
        bedrock: {
          additionalModelRequestFields: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            reasoning_config: {
              type: 'enabled',
              // eslint-disable-next-line @typescript-eslint/naming-convention
              budget_tokens: parseInt(
                process.env.CLAUDE_THINKING_BUDGET ?? '1024',
              ),
            },
          },
        },
      };
    } else {
      defaultSettings.temperature = parseInt(
        process.env.BEDROCK_TEMPERATURE ?? '0',
      );
    }
    return Bedrock.createInstance({
      model: process.env.BEDROCK_MODEL,
      config: {
        region: process.env.BEDROCK_AWS_REGION,
        accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
        defaultSettings,
      },
    });
  }
}
