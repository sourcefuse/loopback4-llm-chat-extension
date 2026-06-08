import {expect} from '@loopback/testlab';
import {Mastra} from '@mastra/core';
import {InMemoryStore} from '@mastra/core/storage';
import {generateQueryWorkflow} from '../../mastra/workflows/db-query/workflows/generate.workflow';
import {improveQueryWorkflow} from '../../mastra/workflows/db-query/workflows/improve.workflow';
import {visualizationWorkflow} from '../../mastra/workflows/visualization/workflows/visualization.workflow';

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
      const result = await run.start({inputData: {prompt: 'top customers'}});
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
      });
      expect(result.status).to.equal('success');
    });
  });
});
