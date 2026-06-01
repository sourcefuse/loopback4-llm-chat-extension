import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {Bedrock} from './bedrock.provider';

export class BedrockNonThinking
  extends Bedrock
  implements Provider<LLMProvider>
{
  value(): LLMProvider {
    return this._createdInstance(false);
  }
}
