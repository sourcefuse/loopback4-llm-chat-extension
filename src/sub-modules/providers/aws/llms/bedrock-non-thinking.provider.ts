import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {Bedrock} from './bedrock.provider';

export class BedrockNonThinking
  extends Bedrock
  implements Provider<LLMProvider>
{
  value(): ValueOrPromise<LLMProvider> {
    return this._createdInstance(false);
  }
}
