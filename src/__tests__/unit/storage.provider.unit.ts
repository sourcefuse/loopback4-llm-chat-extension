import {expect} from '@loopback/testlab';
import {LibSQLStore} from '@mastra/libsql';
import {DefaultStorageProvider} from '../../providers/mastra/storage.provider';

/**
 * Zero-config LibSQL default storage. Counterpart to the opt-in
 * `PostgresStorageProvider` — this is what every consumer gets out of the
 * box when they don't override `AiIntegrationBindings.Storage`. The fail-closed
 * checks live in pg-storage.provider.unit.ts; here we lock the
 * "boots cleanly with no env" promise + env-override wiring.
 */
describe('DefaultStorageProvider (unit)', () => {
  const ORIGINAL_URL = process.env.MASTRA_STORAGE_URL;

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.MASTRA_STORAGE_URL;
    else process.env.MASTRA_STORAGE_URL = ORIGINAL_URL;
  });

  it('returns a LibSQLStore instance with no env configured (zero-config promise)', async () => {
    // Consumers must be able to install the component without setting
    // any env vars and still get a working storage adapter — this is
    // what makes the bundled chat/memory routes "just work" in dev.
    delete process.env.MASTRA_STORAGE_URL;
    const provider = new DefaultStorageProvider();

    const store = await provider.value();

    expect(store).to.be.instanceOf(LibSQLStore);
  });

  it('still returns a LibSQLStore when MASTRA_STORAGE_URL is supplied (env override path)', async () => {
    // Consumers point MASTRA_STORAGE_URL at a Turso replica in
    // production; we cannot assert the URL was actually wired
    // without integration coverage (LibSQLStore hides it) but we can
    // assert the constructor doesn't reject a perfectly valid URL.
    process.env.MASTRA_STORAGE_URL = 'file::memory:';
    const provider = new DefaultStorageProvider();

    const store = await provider.value();

    expect(store).to.be.instanceOf(LibSQLStore);
  });

  it('hands back a fresh LibSQLStore on each call (no in-provider singleton cache)', async () => {
    // Singleton scope is enforced by the LB4 binding, not the provider
    // class — calling .value() twice directly (e.g. in a test) must
    // return two independent instances so resetting one doesn't
    // poison the other.
    const provider = new DefaultStorageProvider();

    const a = await provider.value();
    const b = await provider.value();

    expect(a).to.not.equal(b);
  });
});
