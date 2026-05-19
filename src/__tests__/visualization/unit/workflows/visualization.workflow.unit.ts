import {RequestContext} from '@mastra/core/request-context';
import {expect, sinon} from '@loopback/testlab';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {dbQueryWorkflow} from '../../../../mastra/workflows/db-query/db-query.workflow';
import * as llmHelpers from '../../../../mastra/workflows/db-query/llm-helpers';
import {visualizationWorkflow} from '../../../../mastra/workflows/visualization/visualization.workflow';
import type {IVisualizer} from '../../../../components/visualization/types';

type WorkflowChunk = {
  type: string;
  payload?: {
    output?: {
      type?: string;
      data?: unknown;
    };
  };
};

function createMockStream<TChunk>(
  chunks: TChunk[],
  result: unknown,
): AsyncIterable<TChunk> & {result: Promise<unknown>} {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    result: Promise.resolve(result),
  };
}

describe('VisualizationWorkflow Unit', function () {
  afterEach(() => {
    sinon.restore();
  });

  it('renders visualization using explicit type and existing dataset', async () => {
    const getConfig = sinon.stub().resolves({
      categoryColumn: 'department',
      valueColumn: 'salary',
    });

    const visualizer: IVisualizer = {
      name: 'bar',
      description: 'Bar chart visualizer',
      context: 'requires category and value columns',
      getConfig,
    };

    const datasetStore = {
      findById: sinon.stub().resolves({
        query: 'SELECT department, salary FROM employees',
        description: 'Department salary distribution',
      }),
    };

    const requestContext = new RequestContext();
    requestContext.set('visualizerStore', {
      list: [visualizer],
      map: {bar: visualizer},
    });
    requestContext.set('datasetStore', datasetStore);
    requestContext.set('cheapLlm', {});

    const run = await visualizationWorkflow.createRun();
    const stream = run.stream({
      inputData: {
        prompt: 'Show salary by department',
        datasetId: 'dataset-1',
        type: 'bar',
      },
      requestContext,
    });

    const statuses: string[] = [];
    for await (const chunk of stream) {
      const typedChunk = chunk as WorkflowChunk;
      const output = typedChunk.payload?.output;
      if (
        typedChunk.type === 'workflow-step-output' &&
        output?.type === LLMStreamEventType.ToolStatus
      ) {
        const status = output.data as {status?: string};
        if (typeof status.status === 'string') {
          statuses.push(status.status);
        }
      }
    }

    const result = await stream.result;

    expect(result.status).to.equal('success');
    if (result.status !== 'success') {
      return;
    }

    expect(result.result).to.deepEqual({
      datasetId: 'dataset-1',
      visualizerName: 'bar',
      visualizerConfig: {
        categoryColumn: 'department',
        valueColumn: 'salary',
      },
      done: true,
    });
    expect(datasetStore.findById.calledOnceWith('dataset-1')).to.be.true();
    expect(getConfig.calledOnce).to.be.true();
    expect(statuses).to.containEql('Preparing visualization');
    expect(statuses).to.containEql('Configuring bar');
    expect(statuses).to.containEql('completed');
  });

  it('delegates query generation to dbQueryWorkflow when dataset is not provided', async () => {
    const getConfig = sinon.stub().resolves({
      categoryColumn: 'month',
      valueColumn: 'revenue',
    });

    const visualizer: IVisualizer = {
      name: 'bar',
      description: 'Bar chart visualizer',
      context: 'must include category and numeric value columns',
      getConfig,
    };

    const datasetStore = {
      findById: sinon.stub().resolves({
        query: 'SELECT month, revenue FROM monthly_revenue',
        description: 'Monthly revenue data',
      }),
    };

    const subWorkflowChunks = [
      {
        type: 'workflow-step-output',
        payload: {
          output: {
            type: LLMStreamEventType.Status,
            data: 'db-query-running',
          },
        },
      },
    ];

    const dbQueryStream = createMockStream(subWorkflowChunks, {
      status: 'success',
      result: {
        datasetId: 'generated-dataset',
        done: true,
        replyToUser: 'Dataset generated',
      },
    });

    const subWorkflowRun = {
      stream: sinon.stub().returns(dbQueryStream),
    };

    const createRunStub = sinon
      .stub(dbQueryWorkflow, 'createRun')
      .resolves(
        subWorkflowRun as unknown as Awaited<
          ReturnType<typeof dbQueryWorkflow.createRun>
        >,
      );

    const requestContext = new RequestContext();
    requestContext.set('visualizerStore', {
      list: [visualizer],
      map: {bar: visualizer},
    });
    requestContext.set('datasetStore', datasetStore);
    requestContext.set('cheapLlm', {});
    requestContext.set('fullSchema', {
      tables: {},
      relations: [],
    });

    const run = await visualizationWorkflow.createRun();
    const stream = run.stream({
      inputData: {
        prompt: 'Show monthly revenue trend',
        type: 'bar',
      },
      requestContext,
    });

    const forwardedEvents: string[] = [];
    for await (const chunk of stream) {
      const typedChunk = chunk as WorkflowChunk;
      const output = typedChunk.payload?.output;
      if (
        typedChunk.type === 'workflow-step-output' &&
        output?.type === LLMStreamEventType.Status
      ) {
        const data = output.data;
        if (typeof data === 'string') {
          forwardedEvents.push(data);
        }
      }
    }

    const result = await stream.result;

    expect(result.status).to.equal('success');
    if (result.status !== 'success') {
      return;
    }

    expect(result.result).to.deepEqual({
      datasetId: 'generated-dataset',
      visualizerName: 'bar',
      visualizerConfig: {
        categoryColumn: 'month',
        valueColumn: 'revenue',
      },
      done: true,
    });

    expect(createRunStub.calledOnce).to.be.true();
    expect(subWorkflowRun.stream.calledOnce).to.be.true();
    const dbQueryInput = subWorkflowRun.stream.firstCall.args[0].inputData;

    expect(dbQueryInput.datasetId).to.be.undefined();
    expect(dbQueryInput.directCall).to.be.true();
    expect(dbQueryInput.prompt).to.equal(
      'Generate a query to fetch data for visualization based on the following user prompt: Show monthly revenue trend. Ensure that the query structure satisfies the following context: must include category and numeric value columns',
    );
    expect(forwardedEvents).to.containEql('db-query-running');
  });

  it('returns workflow output with error when selection step resolves to none', async () => {
    const visualizer: IVisualizer = {
      name: 'bar',
      description: 'Bar chart visualizer',
      context: 'requires category and value columns',
      getConfig: sinon.stub().resolves({}),
    };

    const datasetStore = {
      findById: sinon.stub(),
    };

    sinon
      .stub(llmHelpers, 'invokeLlm')
      .resolves('none: this request cannot be represented by available charts');

    const requestContext = new RequestContext();
    requestContext.set('visualizerStore', {
      list: [visualizer],
      map: {bar: visualizer},
    });
    requestContext.set('datasetStore', datasetStore);
    requestContext.set('cheapLlm', {});

    const run = await visualizationWorkflow.createRun();
    const result = await run.start({
      inputData: {
        prompt: 'Render a scatter matrix with clustering details',
      },
      requestContext,
    });

    expect(result.status).to.equal('success');
    if (result.status !== 'success') {
      return;
    }

    const workflowOutput = result.result as {done?: boolean; error?: string};
    expect(workflowOutput.done).to.equal(false);
    expect(workflowOutput.error).to.equal(
      ': this request cannot be represented by available charts',
    );
    expect(datasetStore.findById.called).to.be.false();
  });
});
