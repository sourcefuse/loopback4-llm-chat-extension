import {ChatBedrockConverse, ChatBedrockConverseInput} from '@langchain/aws';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {sanitizeFilenameForAwsConverse} from '../utils';
import {BedrockInstanceConfig} from '../types';

export class Bedrock implements Provider<LLMProvider> {
  static createInstance(config: BedrockInstanceConfig): ChatBedrockConverse {
    const client = new ChatBedrockConverse(config);
    (client as unknown as LLMProvider).getFile = (
      file: Express.Multer.File,
    ) => {
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

  protected _createdInstance(thinking: boolean) {
    if (!process.env.BEDROCK_MODEL) {
      throw new Error(
        'Bedrock model is not specified. Please set the BEDROCK_MODEL environment variable.',
      );
    }
    const config: ChatBedrockConverseInput = {
      model: process.env.BEDROCK_MODEL!,
      region: process.env.BEDROCK_AWS_REGION,
      credentials: {
        accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY!,
      },
    };
    if (process.env.CLAUDE_THINKING && thinking) {
      config.additionalModelRequestFields = {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        reasoning_config: {
          type: 'enabled',
          // eslint-disable-next-line @typescript-eslint/naming-convention
          budget_tokens: parseInt(process.env.CLAUDE_THINKING_BUDGET ?? '1024'),
        },
      };
    } else {
      config.temperature = parseInt(process.env.BEDROCK_TEMPERATURE ?? '0');
    }
    return Bedrock.createInstance({
      model: process.env.BEDROCK_MODEL!,
      ...config,
    });
  }
}
