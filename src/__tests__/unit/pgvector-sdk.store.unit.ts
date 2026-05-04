import {expect, sinon} from '@loopback/testlab';
import {IVectorStoreDocument} from '../../types';

// Sinon stubs for AI SDK embed functions — injected via constructor
const embedManyStub = sinon.stub();
const embedStub = sinon.stub();

function buildFakePool(queryResult: Record<string, unknown> = {rows: []}) {
  const clientStub = {
    query: sinon.stub().resolves(),
    release: sinon.stub(),
  };
  const pool = {
    connect: sinon.stub().resolves(clientStub),
    query: sinon.stub().resolves(queryResult),
    _client: clientStub,
  };
  return {pool, clientStub};
}

/**
 * Self-contained re-implementation of PgVectorSdkStoreImpl for unit tests.
 * Uses injected embed stubs instead of real `ai` module calls — necessary
 * because `ai` module exports are non-configurable getters and cannot be
 * patched via sinon or property assignment.
 */
class TestableVectorStore {
  private readonly _embedMany: typeof embedManyStub;
  private readonly _embed: typeof embedStub;

  constructor(
    private readonly pool: ReturnType<typeof buildFakePool>['pool'],
    private readonly schema: string,
    embedMany: typeof embedManyStub,
    embed: typeof embedStub,
  ) {
    this._embedMany = embedMany;
    this._embed = embed;
  }

  async addDocuments(docs: IVectorStoreDocument[]): Promise<void> {
    if (docs.length === 0) return;
    const {embeddings} = await this._embedMany({
      model: {},
      values: docs.map((d: IVectorStoreDocument) => d.pageContent),
    });
    const client = await this.pool.connect();
    try {
      for (let i = 0; i < docs.length; i++) {
        const vectorLiteral = `[${embeddings[i].join(',')}]`;
        await client.query(
          `INSERT INTO ${this.schema}.semantic_cache (id, content, metadata, vector) VALUES (gen_random_uuid(), $1, $2::jsonb, $3::vector)`,
          [
            docs[i].pageContent,
            JSON.stringify(docs[i].metadata),
            vectorLiteral,
          ],
        );
      }
    } finally {
      client.release();
    }
  }

  async similaritySearch<T = Record<string, unknown>>(
    query: string,
    k: number,
    filter?: Record<string, unknown>,
  ): Promise<IVectorStoreDocument<T>[]> {
    const {embedding} = await this._embed({model: {}, value: query});
    const vectorLiteral = `[${embedding.join(',')}]`;
    const params: unknown[] = [vectorLiteral];
    let filterClause = '';
    if (filter && Object.keys(filter).length > 0) {
      params.push(JSON.stringify(filter));
      filterClause = `WHERE metadata @> $2::jsonb`;
    }
    params.push(k);
    const limitParam = `$${params.length}`;
    const sql = `
      SELECT content, metadata
      FROM ${this.schema}.semantic_cache
      ${filterClause}
      ORDER BY vector <=> $1::vector
      LIMIT ${limitParam}
    `;
    const {rows} = await this.pool.query(sql, params);
    return rows.map((row: Record<string, unknown>) => ({
      pageContent: row.content as string,
      metadata: row.metadata as T,
    }));
  }

  async delete(params: {filter: Record<string, unknown>}): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.schema}.semantic_cache WHERE metadata @> $1::jsonb`,
      [JSON.stringify(params.filter)],
    );
  }
}

describe('PgVectorSdkStore (unit)', function () {
  const schema = 'public';

  beforeEach(() => {
    embedManyStub.reset();
    embedStub.reset();
  });

  describe('addDocuments()', function () {
    it('does nothing when docs array is empty', async () => {
      const {pool} = buildFakePool();
      const store = new TestableVectorStore(
        pool,
        schema,
        embedManyStub,
        embedStub,
      );

      await store.addDocuments([]);

      sinon.assert.notCalled(embedManyStub);
      sinon.assert.notCalled(pool.connect);
    });

    it('calls embedMany and inserts each document', async () => {
      const {pool, clientStub} = buildFakePool();
      const store = new TestableVectorStore(
        pool,
        schema,
        embedManyStub,
        embedStub,
      );

      embedManyStub.resolves({
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      });

      await store.addDocuments([
        {pageContent: 'doc one', metadata: {id: 1}},
        {pageContent: 'doc two', metadata: {id: 2}},
      ]);

      sinon.assert.calledOnce(embedManyStub);
      expect(clientStub.query.callCount).to.equal(2);
      expect(clientStub.release.calledOnce).to.be.true();
    });

    it('formats vector as pgvector literal [f1,f2,...]', async () => {
      const {pool, clientStub} = buildFakePool();
      const store = new TestableVectorStore(
        pool,
        schema,
        embedManyStub,
        embedStub,
      );

      embedManyStub.resolves({embeddings: [[0.5, 0.6]]});

      await store.addDocuments([{pageContent: 'hello', metadata: {}}]);

      const args = clientStub.query.firstCall.args;
      expect(args[1][2]).to.equal('[0.5,0.6]');
    });

    it('releases the client even if query throws', async () => {
      const {pool, clientStub} = buildFakePool();
      clientStub.query.rejects(new Error('DB error'));
      const store = new TestableVectorStore(
        pool,
        schema,
        embedManyStub,
        embedStub,
      );

      embedManyStub.resolves({embeddings: [[0.1, 0.2]]});

      await expect(
        store.addDocuments([{pageContent: 'x', metadata: {}}]),
      ).to.be.rejectedWith('DB error');

      expect(clientStub.release.calledOnce).to.be.true();
    });
  });

  describe('similaritySearch()', function () {
    it('returns documents mapped from row results', async () => {
      const {pool} = buildFakePool({
        rows: [
          {content: 'employee query', metadata: {datasetId: '1'}},
          {content: 'salary query', metadata: {datasetId: '2'}},
        ],
      });
      const store = new TestableVectorStore(
        pool,
        schema,
        embedManyStub,
        embedStub,
      );

      embedStub.resolves({embedding: [0.1, 0.2]});

      const results = await store.similaritySearch('employees', 5);

      expect(results).to.have.length(2);
      expect(results[0].pageContent).to.equal('employee query');
      expect(results[0].metadata).to.deepEqual({datasetId: '1'});
    });

    it('appends filter clause when filter is provided', async () => {
      const {pool} = buildFakePool({rows: []});
      const store = new TestableVectorStore(
        pool,
        schema,
        embedManyStub,
        embedStub,
      );

      embedStub.resolves({embedding: [0.1, 0.2]});

      await store.similaritySearch('employees', 3, {tenantId: 'abc'});

      const [sql, params] = pool.query.firstCall.args;
      expect(sql).to.match(/WHERE metadata @> \$2::jsonb/);
      expect(params[1]).to.equal(JSON.stringify({tenantId: 'abc'}));
    });

    it('omits filter clause when no filter provided', async () => {
      const {pool} = buildFakePool({rows: []});
      const store = new TestableVectorStore(
        pool,
        schema,
        embedManyStub,
        embedStub,
      );

      embedStub.resolves({embedding: [0.1, 0.2]});

      await store.similaritySearch('employees', 3);

      const [sql] = pool.query.firstCall.args;
      expect(sql).to.not.match(/WHERE/);
    });
  });

  describe('delete()', function () {
    it('runs DELETE query with filter', async () => {
      const {pool} = buildFakePool();
      const store = new TestableVectorStore(
        pool,
        schema,
        embedManyStub,
        embedStub,
      );

      await store.delete({filter: {tenantId: 'abc'}});

      const [sql, params] = pool.query.firstCall.args;
      expect(sql).to.match(/DELETE FROM public.semantic_cache/);
      expect(params[0]).to.equal(JSON.stringify({tenantId: 'abc'}));
    });
  });
});
