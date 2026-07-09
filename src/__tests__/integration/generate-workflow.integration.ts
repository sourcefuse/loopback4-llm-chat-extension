import {expect} from '@loopback/testlab';
import {createMockModel} from '@mastra/core/test-utils/llm-mock';
import {RequestContext} from '@mastra/core/request-context';
import {generateQueryGraph} from '../../components/db-query/db-query.graph';
import {makeContainerNodeResolver} from '../fixtures/step-resolver';

/**
 * In-CI equivalent of v2 main's db-query.graph.acceptance: drives the whole
 * generateQueryGraph end-to-end (prompt -> tables -> SQL -> validate ->
 * persist) with a MOCKED smart model returning SQL and stub schema/connector/
 * dataset deps wired through RequestContext. Asserts a real dataset is
 * persisted with the generated SQL.
 *
 * Only the smart tier is bound (no cheapLlm), so the cheap-tier steps
 * (cache-judge, column-narrowing, checklist) self-skip — keeping a single
 * deterministic mock model sufficient for the whole run.
 */
describe('generateQueryGraph (integration, mocked model)', () => {
  const SQL = 'SELECT name FROM employees';
  const schema = {
    tables: {employees: {columns: {id: {}, name: {}, salary: {}}}},
  };

  function buildContext(): {ctx: RequestContext; saved: object[]} {
    const saved: object[] = [];
    const schemaStore = {get: () => schema, filteredSchema: () => schema};
    const connector = {
      validate: async () => {}, // SQL parses/EXPLAINs cleanly
      execute: async () => [{name: 'Alice'}],
    };
    const datasetStore = {
      create: async (d: object) => {
        const row = {...d, id: 'ds1'};
        saved.push(row);
        return row;
      },
      findById: async () => saved[0],
    };
    const authUser = {tenantId: 't1', id: 'u1'};
    const smartModel = createMockModel({mockText: SQL, version: 'v2'});
    // Single-table queries route SQL generation to the CHEAP tier (v2 cost
    // optimisation), so bind it too — otherwise generation self-skips.
    const cheapModel = createMockModel({mockText: SQL, version: 'v2'});

    const ctx = new RequestContext();
    // Collaborators for the steps not yet on constructor DI still read from rc.
    ctx.set('schemaStore', schemaStore as never);
    ctx.set('dbConnector', connector as never);
    ctx.set('datasetStore', datasetStore as never);
    ctx.set('authUser', authUser as never);
    ctx.set('smartLlm', smartModel as never);
    ctx.set('cheapLlm', cheapModel as never);
    ctx.set('resourceId', 't1:u1');
    ctx.set('eventWriter', () => {});
    // Steps converted to constructor DI (e.g. sql-and-validate) resolve their
    // collaborators from a real Context, exactly as WorkflowRunner does — bind
    // the same stubs there. (Steps still on rc-accessors ignore these.)
    const {resolver} = makeContainerNodeResolver({
      connector,
      schemaStore,
      datasetStore,
      authUser,
      smartModel,
      cheapModel,
    });
    ctx.set('resolveNode', resolver);
    return {ctx, saved};
  }

  it('runs prompt -> SQL -> validate -> persisted dataset', async () => {
    const {ctx, saved} = buildContext();
    const run = await generateQueryGraph.createRun();
    const result = await run.start({
      inputData: {prompt: 'list employee names'},
      requestContext: ctx,
    });

    expect(result.status).to.equal('success');
    expect(saved).to.have.length(1);
    expect((saved[0] as {query?: string}).query).to.equal(SQL);
    expect((saved[0] as {tenantId?: string}).tenantId).to.equal('t1');
  });
});
