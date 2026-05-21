import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider} from '@loopback/core';
import type {MastraModelConfig} from '@mastra/core/llm';

/**
 * AI SDK / Mastra-shaped AWS Bedrock provider. Bind to MastraChatLLM.
 * Thinking ('reasoning_config') is applied at agent.stream() call-time via
 * providerOptions, not at model construction. The legacy `Bedrock`
 * provider's `getFile()` shim is dropped — AI SDK handles file parts via
 * the message content shape `[{type: 'file', data, mediaType}]`.
 */
export class MastraBedrock implements Provider<MastraModelConfig> {
  value(): MastraModelConfig {
    if (!process.env.BEDROCK_MODEL) {
      throw new Error('BEDROCK_MODEL env var required for MastraBedrock');
    }
    const provider = createAmazonBedrock({
      region: process.env.BEDROCK_AWS_REGION,
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
    });
    return provider(process.env.BEDROCK_MODEL);
  }
}
