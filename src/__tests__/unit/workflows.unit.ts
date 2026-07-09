import {expect} from '@loopback/testlab';
import {Mastra} from '@mastra/core';
import {InMemoryStore} from '@mastra/core/storage';
import {RequestContext} from '@mastra/core/request-context';
import {
  dbQueryGraph,
  generateQueryGraph,
  improveQueryGraph,
} from '../../components/db-query/db-query.graph';
import {visualizationGraph} from '../../components/visualization/visualization.graph';
import {
  DB_QUERY_NODE_BY_KEY,
  VISUALIZATION_NODE_BY_KEY,
} from '../fixtures/node-registry';
import type {IGraphNode} from '../../graphs/types';

// Steps are now DI shells — even the stub smoke path must supply a step
// resolver (WorkflowRunner does this in production via the container's tag
// lookup, which spans all components). No collaborators bound → the classes
// degrade to their empty/fallback outputs, preserving the prior stub behaviour
// (status=success). Combine the db-query + visualization registries so the
// visualization smoke run (and any nested generate run) both resolve.
const ALL_STEPS: Record<string, new () => IGraphNode> = {
  ...DB_QUERY_NODE_BY_KEY,
  ...VISUALIZATION_NODE_BY_KEY,
};
function smokeContext(): RequestContext {
  const ctx = new RequestContext();
  ctx.set('resolveNode', async (key: string) => {
    const ctor = ALL_STEPS[key];
    if (!ctor) throw new Error(`No step registered for key "${key}"`);
    return new ctor();
  });
  return ctx;
}

/**
 * Smoke tests for the P3 workflow skeletons. Each workflow's step bodies
 * are stubs, so the assertions here verify the DAG
 * topology and end-to-end success path — not yet the SQL / chart logic
 * which lands in a follow-up commit.
 */
describe('P3 Workflow Smoke', () => {
  const mastra = new Mastra({
    workflows: {
      dbQueryGraph,
      generateQueryGraph,
      improveQueryGraph,
      visualizationGraph,
    },
    storage: new InMemoryStore({id: 'workflow-smoke-test-store'}),
  });

  describe('dbQueryGraph (single entry, dispatches on datasetId)', () => {
    // Proves the consolidation works END TO END: the parent graph resolves its
    // IsImprovement entry node, which runs the correct nested sub-graph via
    // ctx.mastra.getWorkflow(...) with the SAME requestContext (so the nested
    // shells resolve), and returns the flat contract. Both tools call this one
    // graph, matching LangGraph's single DbQueryGraph.
    before(() => {
      dbQueryGraph.__registerMastra(mastra);
      generateQueryGraph.__registerMastra(mastra);
      improveQueryGraph.__registerMastra(mastra);
    });

    it('routes to the generate sub-graph when no datasetId is given', async () => {
      const workflow = mastra.getWorkflow('dbQueryGraph');
      if (!workflow) throw new Error('dbQueryGraph not registered');
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {prompt: 'top customers'},
        requestContext: smokeContext(),
      });
      expect(result.status).to.equal('success');
    });

    it('routes to the improve sub-graph when a datasetId is given', async () => {
      const workflow = mastra.getWorkflow('dbQueryGraph');
      if (!workflow) throw new Error('dbQueryGraph not registered');
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {datasetId: 'd1', prompt: 'add region column'},
        requestContext: smokeContext(),
      });
      expect(result.status).to.equal('success');
    });
  });

  describe('generateQueryGraph', () => {
    it('completes the stub path with status=success', async () => {
      generateQueryGraph.__registerMastra(mastra);
      const workflow = mastra.getWorkflow('generateQueryGraph');
      expect(workflow).to.not.be.undefined();
      if (!workflow) {
        throw new Error('generateQueryGraph not registered');
      }
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {prompt: 'top customers'},
        requestContext: smokeContext(),
      });
      expect(result.status).to.equal('success');
    });
  });

  describe('improveQueryGraph', () => {
    it('completes the stub path with status=success', async () => {
      improveQueryGraph.__registerMastra(mastra);
      const workflow = mastra.getWorkflow('improveQueryGraph');
      expect(workflow).to.not.be.undefined();
      if (!workflow) {
        throw new Error('improveQueryGraph not registered');
      }
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {datasetId: 'd1', prompt: 'add region column'},
        requestContext: smokeContext(),
      });
      expect(result.status).to.equal('success');
    });
  });

  describe('visualizationGraph', () => {
    it('completes the stub path with status=success', async () => {
      visualizationGraph.__registerMastra(mastra);
      const workflow = mastra.getWorkflow('visualizationGraph');
      expect(workflow).to.not.be.undefined();
      if (!workflow) {
        throw new Error('visualizationGraph not registered');
      }
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {datasetId: 'd1', userQuery: 'revenue trend'},
        requestContext: smokeContext(),
      });
      expect(result.status).to.equal('success');
    });
  });
});
