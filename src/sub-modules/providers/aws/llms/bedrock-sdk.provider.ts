import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';

/**
 * AI SDK (Vercel) provider for AWS Bedrock models.
 *
 * Returns a `LanguageModel` compatible with `generateText()` / `generateObject()`
 * from the `ai` package.  Bind to `AiIntegrationBindings.AiSdkSmartLLM` (or the
 * other `AiSdk*` keys) for use in the Mastra db-query workflow nodes.
 *
 * Environment variables:
 *   - `BEDROCK_MODEL`                   — model id, e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`
 *   - `BEDROCK_AWS_REGION`              — AWS region
 *   - `BEDROCK_AWS_ACCESS_KEY_ID`       — AWS access key
 *   - `BEDROCK_AWS_SECRET_ACCESS_KEY`   — AWS secret key
 *   - `CLAUDE_THINKING`                 — set to `'true'` to enable extended thinking
 *   - `CLAUDE_THINKING_BUDGET`          — token budget for extended thinking (default 1024)
 */
export class BedrockSdk implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    return this._createInstance(true);
  }

  protected _createInstance(thinking: boolean): LLMProvider {
    if (!process.env.BEDROCK_MODEL) {
      throw new Error('BEDROCK_MODEL environment variable is not set');
    }
    const bedrock = createAmazonBedrock({
      region: process.env.BEDROCK_AWS_REGION ?? 'us-east-1',
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY!,
    });
    // reasoning_config is passed per-call via providerOptions in generateText()
    // thinking flag is reserved for Phase 3 generateText() call sites
    thinking; // eslint-disable-line no-unused-expressions
    return bedrock(process.env.BEDROCK_MODEL);
  }
}
