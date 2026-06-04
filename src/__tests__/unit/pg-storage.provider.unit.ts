import {expect} from '@loopback/testlab';
import {PostgresMastraStorageProvider} from '../../providers/mastra/pg-storage.provider';

/**
 * Unit coverage for the opt-in Postgres storage provider (issue #17). Only the
 * fail-closed guard is asserted here — the success paths construct a real
 * `PostgresStore` (and its `pg` pool), which belongs in an integration test
 * against a live database, not a unit test.
 */
describe('PostgresMastraStorageProvider (unit)', () => {
  const PG_ENV = [
    'MASTRA_PG_CONNECTION_STRING',
    'MASTRA_PG_HOST',
    'MASTRA_PG_PORT',
    'MASTRA_PG_DATABASE',
    'MASTRA_PG_USER',
    'MASTRA_PG_PASSWORD',
    'MASTRA_PG_SCHEMA',
    'MASTRA_PG_SSL',
    'MASTRA_STORAGE_ID',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of PG_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of PG_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('fails closed when no Postgres configuration is present', async () => {
    const provider = new PostgresMastraStorageProvider();
    await expect(provider.value()).to.be.rejectedWith(
      /MASTRA_PG_CONNECTION_STRING/,
    );
  });

  it('fails closed when the host config is incomplete (missing password)', async () => {
    process.env.MASTRA_PG_HOST = 'localhost';
    process.env.MASTRA_PG_DATABASE = 'db';
    process.env.MASTRA_PG_USER = 'user';
    // MASTRA_PG_PASSWORD intentionally unset
    const provider = new PostgresMastraStorageProvider();
    await expect(provider.value()).to.be.rejectedWith(/Postgres configuration/);
  });
});
