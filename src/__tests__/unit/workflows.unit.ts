import {expect} from '@loopback/testlab';
import {Mastra} from '@mastra/core';
import {InMemoryStore} from '@mastra/core/storage';
import {RequestContext} from '@mastra/core/request-context';
import {generateQueryWorkflow} from '../../components/db-query/workflows/generate.workflow';
import {improveQueryWorkflow} from '../../components/db-query/workflows/improve.workflow';
import {visualizationWorkflow} from '../../components/visualization/workflows/visualization.workflow';
import {DB_QUERY_STEP_BY_KEY} from '../../components/db-query/steps';
import {VISUALIZATION_STEP_BY_KEY} from '../../components/visualization/steps';
import type {IWorkflowStep} from '../../graphs/types';

// Steps are now DI shells — even the stub smoke path must supply a step
// resolver (WorkflowRunner does this in production via the container's tag
// lookup, which spans all components). No collaborators bound → the classes
// degrade to their empty/fallback outputs, preserving the prior stub behaviour
// (status=success). Combine the db-query + visualization registries so the
// visualization smoke run (and any nested generate run) both resolve.
const ALL_STEPS: Record<string, new () => IWorkflowStep> = {
  ...DB_QUERY_STEP_BY_KEY,
  ...VISUALIZATION_STEP_BY_KEY,
};
function smokeContext(): RequestContext {
  const ctx = new RequestContext();
  ctx.set('resolveStep', async (key: string) => {
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
      generateQueryWorkflow,
      improveQueryWorkflow,
      visualizationWorkflow,
    },
    storage: new InMemoryStore({id: 'workflow-smoke-test-store'}),
  });

  describe('generateQueryWorkflow', () => {
    it('completes the stub path with status=success', async () => {
      generateQueryWorkflow.__registerMastra(mastra);
      const workflow = mastra.getWorkflow('generateQueryWorkflow');
      expect(workflow).to.not.be.undefined();
      if (!workflow) {
        throw new Error('generateQueryWorkflow not registered');
      }
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {prompt: 'top customers'},
        requestContext: smokeContext(),
      });
      expect(result.status).to.equal('success');
    });
  });

  describe('improveQueryWorkflow', () => {
    it('completes the stub path with status=success', async () => {
      improveQueryWorkflow.__registerMastra(mastra);
      const workflow = mastra.getWorkflow('improveQueryWorkflow');
      expect(workflow).to.not.be.undefined();
      if (!workflow) {
        throw new Error('improveQueryWorkflow not registered');
      }
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {datasetId: 'd1', prompt: 'add region column'},
        requestContext: smokeContext(),
      });
      expect(result.status).to.equal('success');
    });
  });

  describe('visualizationWorkflow', () => {
    it('completes the stub path with status=success', async () => {
      visualizationWorkflow.__registerMastra(mastra);
      const workflow = mastra.getWorkflow('visualizationWorkflow');
      expect(workflow).to.not.be.undefined();
      if (!workflow) {
        throw new Error('visualizationWorkflow not registered');
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
