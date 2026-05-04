import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {BedrockSdk} from './bedrock-sdk.provider';

/**
 * AI SDK (Vercel) provider for AWS Bedrock models with extended thinking disabled.
 *
 * Identical to `BedrockSdk` but always passes `thinking: false` so the model
 * runs without the reasoning budget.  Bind to
 * `AiIntegrationBindings.AiSdkSmartNonThinkingLLM` or `AiSdkCheapLLM` as needed.
 */
export class BedrockNonThinkingSdk
  extends BedrockSdk
  implements Provider<LLMProvider>
{
  value(): ValueOrPromise<LLMProvider> {
    return this._createInstance(false);
  }
}
