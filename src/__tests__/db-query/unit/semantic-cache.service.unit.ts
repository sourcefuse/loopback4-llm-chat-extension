import {expect, sinon} from '@loopback/testlab';
import {SemanticCacheService} from '../../../components/db-query/services/semantic-cache.service';
import {DbQueryStoredTypes} from '../../../components/db-query/types';

/**
 * Unit coverage for the tenant-isolation boundary + the (deliberately
 * asymmetric) error contract of SemanticCacheService:
 *   - search  → best-effort: degrades to [] on failure (never throws)
 *   - upsert  → canonical write: surfaces failure (rethrows) so callers
 *               don't report success for an unwritten document
 *   - delete  → surfaces failure (rethrows) so stale entries don't hide
 * Plus the legacy-embedder fallback and the concurrent index-create race.
 */
describe('SemanticCacheService Unit', () => {
  type VectorStoreStub = {
    query: sinon.SinonStub;
    upsert: sinon.SinonStub;
    deleteVectors: sinon.SinonStub;
    listIndexes: sinon.SinonStub;
    createIndex: sinon.SinonStub;
  };

  let vectorStore: VectorStoreStub;
  let legacyEmbedder: {embedDocuments: sinon.SinonStub};

  beforeEach(() => {
    vectorStore = {
      query: sinon.stub().resolves([]),
      upsert: sinon.stub().resolves(),
      deleteVectors: sinon.stub().resolves(),
      listIndexes: sinon.stub().resolves(['semantic_cache']),
      createIndex: sinon.stub().resolves(),
    };
    legacyEmbedder = {embedDocuments: sinon.stub().resolves([[0.1, 0.2, 0.3]])};
  });

  function makeService(): SemanticCacheService {
    return new SemanticCacheService(
      vectorStore as never,
      legacyEmbedder as never,
    );
  }

  it('passes the tenant + type filter to vectorStore.query and maps results', async () => {
    vectorStore.query.resolves([
      {
        metadata: {
          tenantId: 'tenant-1',
          type: DbQueryStoredTypes.DataSet,
          datasetId: 'ds-1',
          pageContent: 'top earners',
        },
        document: 'top earners',
      },
    ]);

    const out = await makeService().search('who earns most', {
      type: DbQueryStoredTypes.DataSet,
      tenantId: 'tenant-1',
    });

    sinon.assert.calledWithMatch(vectorStore.query, {
      indexName: 'semantic_cache',
      topK: 5,
      filter: {type: DbQueryStoredTypes.DataSet, tenantId: 'tenant-1'},
    });
    expect(out).to.have.length(1);
    expect(out[0].pageContent).to.equal('top earners');
    expect(out[0].metadata.datasetId).to.equal('ds-1');
    // pageContent is lifted out of metadata, not duplicated inside it
    expect(out[0].metadata).to.not.have.property('pageContent');
  });

  it('returns [] without querying when tenantId is missing', async () => {
    const out = await makeService().search('q', {
      type: DbQueryStoredTypes.DataSet,
      tenantId: '',
    });
    expect(out).to.eql([]);
    sinon.assert.notCalled(vectorStore.query);
  });

  it('search degrades to [] (does not throw) when the vector store fails', async () => {
    vectorStore.query.rejects(new Error('vector store down'));
    const out = await makeService().search('q', {
      type: DbQueryStoredTypes.Template,
      tenantId: 'tenant-1',
    });
    expect(out).to.eql([]);
  });

  it('returns [] when no vector store / embedder is bound', async () => {
    const svc = new SemanticCacheService(undefined, undefined);
    expect(
      await svc.search('q', {type: DbQueryStoredTypes.DataSet, tenantId: 't'}),
    ).to.eql([]);
  });

  it('upsertDocument RETHROWS on write failure (no silent data loss)', async () => {
    vectorStore.upsert.rejects(new Error('boom'));
    await expect(
      makeService().upsertDocument({
        pageContent: 'a template',
        metadata: {
          id: 't-1',
          tenantId: 'tenant-1',
          type: DbQueryStoredTypes.Template,
        },
      }),
    ).to.be.rejectedWith(/boom/);
  });

  it('upsertDocument is a no-op (no throw) when store/embedder unbound', async () => {
    const svc = new SemanticCacheService(undefined, undefined);
    await svc.upsertDocument({pageContent: 'x', metadata: {}});
    // nothing to assert beyond "did not throw"
  });

  it('deleteByFilter RETHROWS so stale entries surface', async () => {
    vectorStore.deleteVectors.rejects(new Error('delete failed'));
    await expect(
      makeService().deleteByFilter({
        type: DbQueryStoredTypes.DataSet,
        tenantId: 'tenant-1',
      }),
    ).to.be.rejectedWith(/delete failed/);
  });

  it('uses the legacy embedDocuments shape and rejects an empty vector', async () => {
    legacyEmbedder.embedDocuments.resolves([]);
    await expect(
      makeService().upsertDocument({
        pageContent: 'x',
        metadata: {id: '1', tenantId: 't', type: DbQueryStoredTypes.Template},
      }),
    ).to.be.rejectedWith(/empty embedding vector/);
  });

  it('recovers from a concurrent index-create race (createIndex throws but index then exists)', async () => {
    vectorStore.listIndexes.onFirstCall().resolves([]); // absent at first check
    vectorStore.createIndex.rejects(new Error('already exists'));
    vectorStore.listIndexes.onSecondCall().resolves(['semantic_cache']); // appeared

    await makeService().upsertDocument({
      pageContent: 'x',
      metadata: {id: '1', tenantId: 't', type: DbQueryStoredTypes.Template},
    });
    sinon.assert.called(vectorStore.upsert);
  });

  it('throws a clear error when index creation truly fails', async () => {
    vectorStore.listIndexes.resolves([]); // never appears
    vectorStore.createIndex.rejects(new Error('permission denied'));
    await expect(
      makeService().upsertDocument({
        pageContent: 'x',
        metadata: {id: '1', tenantId: 't', type: DbQueryStoredTypes.Template},
      }),
    ).to.be.rejectedWith(/Unable to create vector index/);
  });
});
