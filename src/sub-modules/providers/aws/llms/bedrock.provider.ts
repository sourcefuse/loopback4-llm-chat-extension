import {ChatBedrockConverse} from '@langchain/aws';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Bedrock implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    if (!process.env.BEDROCK_MODEL) {
      throw new Error(
        'Bedrock model is not specified. Please set the BEDROCK_MODEL environment variable.',
      );
    }
    const client = new ChatBedrockConverse({
      model: process.env.BEDROCK_MODEL!,
      region: process.env.BEDROCK_AWS_REGION,
      credentials: {
        accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY!,
      },
    });
    (client as unknown as LLMProvider).getFile = (
      file: Express.Multer.File,
    ) => {
      return {
        type: 'document',
        document: {
          format: 'pdf',
          name: this.sanitizeFilenameForAwsConverse(file.originalname),
          source: {
            bytes: file.buffer,
          },
        },
      };
    };
    return client;
  }

  private sanitizeFilenameForAwsConverse(filename: string): string {
    // Remove file extension if present
    const nameWithoutExt = filename.includes('.')
      ? filename.substring(0, filename.lastIndexOf('.'))
      : filename;

    // Keep only allowed characters: alphanumeric, whitespace, hyphens, parentheses, square brackets
    let sanitized = nameWithoutExt.replace(/[^a-zA-Z0-9\s\-()[\]]]/g, '');

    // Replace multiple consecutive whitespaces with single space
    sanitized = sanitized.replace(/\s+/g, ' ');

    // Trim leading/trailing whitespace
    sanitized = sanitized.trim();

    return sanitized;
  }
}
