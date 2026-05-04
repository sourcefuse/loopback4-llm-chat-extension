import {injectable, BindingScope, Provider} from '@loopback/core';
import {IVectorStore, IVectorStoreDocument} from '../../types';

/**
 * Simple in-memory vector store for testing.
 * No actual vector embeddings — uses string matching.
 */
@injectable({scope: BindingScope.SINGLETON})
export class InMemoryVectorStore implements Provider<IVectorStore> {
  value(): IVectorStore {
    return new InMemoryVectorStoreImpl();
  }
}

class InMemoryVectorStoreImpl implements IVectorStore {
  private docs: IVectorStoreDocument[] = [];

  async addDocuments(docs: IVectorStoreDocument[]): Promise<void> {
    this.docs.push(...docs);
  }

  async similaritySearch<T = Record<string, unknown>>(
    query: string,
    k: number,
    filter?: Record<string, unknown>,
  ): Promise<IVectorStoreDocument<T>[]> {
    let results = this.docs as IVectorStoreDocument<T>[];
    if (filter) {
      results = results.filter(doc =>
        Object.entries(filter).every(
          ([key, value]) =>
            (doc.metadata as Record<string, unknown>)[key] === value,
        ),
      );
    }
    return results.slice(0, k);
  }

  async delete(params: {filter: Record<string, unknown>}): Promise<void> {
    this.docs = this.docs.filter(
      doc =>
        !Object.entries(params.filter).every(
          ([key, value]) =>
            (doc.metadata as Record<string, unknown>)[key] === value,
        ),
    );
  }
}
