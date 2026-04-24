import {Provider, ValueOrPromise} from '@loopback/core';
import {RuntimeLLMProvider} from '../../../../types';
import {Bedrock} from './bedrock.provider';

export class BedrockNonThinking
  extends Bedrock
  implements Provider<RuntimeLLMProvider>
{
  value(): ValueOrPromise<RuntimeLLMProvider> {
    return this._createdInstance(false);
  }
}
