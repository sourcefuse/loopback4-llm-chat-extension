import {expect} from '@loopback/testlab';
import {generateQueryWorkflow} from '../../mastra/workflows/db-query/generate.workflow';
import {improveQueryWorkflow} from '../../mastra/workflows/db-query/improve.workflow';
import {visualizationWorkflow} from '../../mastra/workflows/visualization.workflow';

/**
 * Smoke tests for the P3 workflow skeletons. Each workflow's step bodies
 * are stubs (Section 9.1-9.3), so the assertions here verify the DAG
 * topology and end-to-end success path — not yet the SQL / chart logic
 * which lands in a follow-up commit.
 */
describe('P3 Workflow Smoke', () => {
  describe('generateQueryWorkflow', () => {
    it('completes the stub path with status=success', async () => {
      const run = await generateQueryWorkflow.createRun();
      const result = await run.start({inputData: {prompt: 'top customers'}});
      expect(result.status).to.equal('success');
    });
  });

  describe('improveQueryWorkflow', () => {
    it('completes the stub path with status=success', async () => {
      const run = await improveQueryWorkflow.createRun();
      const result = await run.start({
        inputData: {datasetId: 'd1', prompt: 'add region column'},
      });
      expect(result.status).to.equal('success');
    });
  });

  describe('visualizationWorkflow', () => {
    it('completes the stub path with status=success', async () => {
      const run = await visualizationWorkflow.createRun();
      const result = await run.start({
        inputData: {datasetId: 'd1', userQuery: 'revenue trend'},
      });
      expect(result.status).to.equal('success');
    });
  });
});
