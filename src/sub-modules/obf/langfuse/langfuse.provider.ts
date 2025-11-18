import {Provider, ValueOrPromise} from '@loopback/core';
import {CallbackHandler} from '@langfuse/langchain';

export class LangfuseObfProvider implements Provider<CallbackHandler> {
  value(): ValueOrPromise<CallbackHandler> {
    return new CallbackHandler();
  }
}
