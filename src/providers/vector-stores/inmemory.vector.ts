import {Provider, ValueOrPromise} from '@loopback/core';
import {LibSQLVector} from '@mastra/libsql';
import type {MastraVector} from '@mastra/core/vector';

export class InMemoryVectorStore implements Provider<MastraVector> {
  value(): ValueOrPromise<MastraVector> {
    return new LibSQLVector({
      id: 'mastra-inmemory-vector',
      url: 'file::memory:',
    });
  }
}
