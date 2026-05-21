import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {sanitizeFilenameForAwsConverse} from '../utils';
import {BedrockInstanceConfig} from '../types';

export class Bedrock implements Provider<LLMProvider> {
  static createInstance(config: BedrockInstanceConfig): LLMProvider {
    const provider = createAmazonBedrock(config.providerSettings);
    const client = provider(config.model) as unknown as LLMProvider;

    client.getFile = (file: Express.Multer.File) => {
      return {
        type: 'document',
        document: {
          format: 'pdf',
          name: sanitizeFilenameForAwsConverse(file.originalname),
          source: {
            bytes: file.buffer,
          },
        },
      };
    };

    return client;
  }

  value(): ValueOrPromise<LLMProvider> {
    return this._createdInstance(true);
  }

  protected _createdInstance(thinking: boolean): LLMProvider {
    const configuredModel =
      !thinking && process.env.BEDROCK_NON_THINKING_MODEL
        ? process.env.BEDROCK_NON_THINKING_MODEL
        : process.env.BEDROCK_MODEL;

    if (!configuredModel) {
      throw new Error(
        'Bedrock model is not specified. Please set the BEDROCK_MODEL environment variable.',
      );
    }

    if (!process.env.BEDROCK_AWS_REGION) {
      throw new Error(
        'BEDROCK_AWS_REGION environment variable is not set for Bedrock provider.',
      );
    }

    const providerSettings: NonNullable<
      BedrockInstanceConfig['providerSettings']
    > = {
      region: process.env.BEDROCK_AWS_REGION,
    };

    const accessKeyId = process.env.BEDROCK_AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
    if (accessKeyId && secretAccessKey) {
      providerSettings.accessKeyId = accessKeyId;
      providerSettings.secretAccessKey = secretAccessKey;
      if (process.env.BEDROCK_AWS_SESSION_TOKEN) {
        providerSettings.sessionToken = process.env.BEDROCK_AWS_SESSION_TOKEN;
      }
    }

    return Bedrock.createInstance({
      model: configuredModel,
      providerSettings,
    });
  }
}
