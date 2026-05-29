import {Context} from '@loopback/core';
import {expect, sinon} from '@loopback/testlab';
import {WorkflowRunner} from '../../mastra/bridge/workflow-runner';
import {InProcessRunRegistry} from '../../mastra/bridge/run-registry';
import {UsageAccumulator} from '../../services/usage-accumulator.service';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import {ToolStatus} from '../../graphs/types';

// Set defensively; the unit suite drives a stubbed Mastra (getAgent returns
// a stub agent whose getMemory/stream are sinon stubs), so the real model is
// never resolved here.
process.env.MASTRA_DEFAULT_CHAT_MODEL ??= 'mock/test-model';

type Chunk =
  | {type: 'text-delta'; payload: {text: string}}
  | {
      type: 'tool-call';
      payload: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      };
    }
  | {
      type: 'tool-call-approval';
      payload: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      };
    }
  | {type: 'tripwire'; payload: {processorId: string; reason: string}}
  | {type: 'error'; payload: {error: Error}}
  | {type: 'finish'; payload: {output: {finishReason: string}; runId?: string}};

async function* yieldChunks(chunks: Chunk[]): AsyncIterable<Chunk> {
  for (const c of chunks) yield c;
}

async function collect(
  iter: AsyncIterable<LLMStreamEvent>,
): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe('WorkflowRunner Unit', () => {
  let streamStub: sinon.SinonStub;
  let getMemoryStub: sinon.SinonStub;
  let createThread: sinon.SinonStub;
  let getThreadById: sinon.SinonStub;
  let memoryStub: {
    createThread: sinon.SinonStub;
    getThreadById: sinon.SinonStub;
  };
  let mastraStub: {getAgent: sinon.SinonStub};
  let usage: UsageAccumulator;
  let runRegistry: InProcessRunRegistry;

  beforeEach(() => {
    createThread = sinon.stub();
    getThreadById = sinon.stub();
    memoryStub = {createThread, getThreadById};
    // run() now streams the agent returned by `mastra.getAgent('chatAgent')`
    // (the registered, observability-bound agent) instead of a detached
    // `new Agent()`. Stub that agent's getMemory + stream directly.
    getMemoryStub = sinon.stub().resolves(memoryStub);
    streamStub = sinon.stub();
    mastraStub = {
      getAgent: sinon
        .stub()
        .returns({getMemory: getMemoryStub, stream: streamStub}),
    };
    usage = new UsageAccumulator();
    runRegistry = new InProcessRunRegistry();
  });

  afterEach(() => {
    sinon.restore();
  });

  function makeRunner(resourceIdValue?: string): WorkflowRunner {
    return new WorkflowRunner(
      new Context('test'),
      mastraStub as never,
      undefined,
      runRegistry,
      resourceIdValue,
      undefined,
      usage,
    );
  }

  function stubStreamWith(
    chunks: Chunk[],
    usageValue = {inputTokens: 11, outputTokens: 5},
  ) {
    streamStub.resolves({
      fullStream: yieldChunks(chunks),
      usage: Promise.resolve(usageValue),
    });
  }

  it('emits Init then coalesces text-delta chunks into one Message and finishes with TokenCount', async () => {
    createThread.resolves({id: 'thread-new'});
    stubStreamWith([
      {type: 'text-delta', payload: {text: 'Hello '}},
      {type: 'text-delta', payload: {text: 'world'}},
    ]);

    const runner = makeRunner();
    const abort = new AbortController();

    const events = await collect(runner.run('hi', undefined, abort.signal));

    expect(events.map(e => e.type)).to.eql([
      LLMStreamEventType.Init,
      LLMStreamEventType.Message,
      LLMStreamEventType.TokenCount,
    ]);
    expect((events[0] as {data: {sessionId: string}}).data.sessionId).to.equal(
      'thread-new',
    );
    expect((events[1] as {data: {message: string}}).data.message).to.equal(
      'Hello world',
    );
    expect(
      (events[2] as {data: {inputTokens: number; outputTokens: number}}).data,
    ).to.eql({
      inputTokens: 11,
      outputTokens: 5,
    });
    expect(usage.flush()['chat-llm']).to.eql({input: 11, output: 5});
  });

  it('reuses an existing thread when sessionId is provided and omits Init', async () => {
    getThreadById.resolves({
      id: 'thread-existing',
      resourceId: 'tenant-1:user-1',
    });
    stubStreamWith([{type: 'text-delta', payload: {text: 'ok'}}]);

    const events = await collect(
      makeRunner().run(
        'cont',
        undefined,
        new AbortController().signal,
        'thread-existing',
      ),
    );

    expect(events.map(e => e.type)).to.eql([
      LLMStreamEventType.Message,
      LLMStreamEventType.TokenCount,
    ]);
    sinon.assert.calledOnce(getThreadById);
    sinon.assert.notCalled(createThread);
  });

  it('emits Error and stops when sessionId thread is not found', async () => {
    getThreadById.resolves(null);

    const events = await collect(
      makeRunner().run(
        'cont',
        undefined,
        new AbortController().signal,
        'missing',
      ),
    );

    expect(events).to.have.length(1);
    expect(events[0].type).to.equal(LLMStreamEventType.Error);
    expect((events[0] as {data: {message: string}}).data.message).to.match(
      /missing/,
    );
  });

  it('emits Error and stops when Memory is not configured', async () => {
    getMemoryStub.resolves(null);

    const events = await collect(
      makeRunner().run('hi', undefined, new AbortController().signal),
    );

    expect(events).to.have.length(1);
    expect(events[0].type).to.equal(LLMStreamEventType.Error);
    expect((events[0] as {data: {message: string}}).data.message).to.match(
      /Memory/,
    );
  });

  it('maps tool-call chunks to Tool events with the toolCallId from payload', async () => {
    createThread.resolves({id: 't1'});
    stubStreamWith([
      {
        type: 'tool-call',
        payload: {
          toolCallId: 'tc-123',
          toolName: 'get-data',
          args: {prompt: 'top customers'},
        },
      },
      {type: 'text-delta', payload: {text: 'done'}},
    ]);

    const events = await collect(
      makeRunner().run('q', undefined, new AbortController().signal),
    );

    const toolEvent = events.find(e => e.type === LLMStreamEventType.Tool);
    expect(toolEvent).to.not.be.undefined();
    expect(
      (toolEvent as {data: {id: string; tool: string; data: unknown}}).data,
    ).to.eql({
      id: 'tc-123',
      tool: 'get-data',
      data: {prompt: 'top customers'},
    });
  });

  it('maps tool-call-approval chunks to ToolStatus.AwaitingApproval', async () => {
    createThread.resolves({id: 't1'});
    stubStreamWith([
      {
        type: 'tool-call-approval',
        payload: {
          toolCallId: 'tc-9',
          toolName: 'delete-dataset',
          args: {datasetId: 'd9'},
        },
      },
    ]);

    const events = await collect(
      makeRunner().run('q', undefined, new AbortController().signal),
    );

    const status = events.find(
      e => e.type === LLMStreamEventType.ToolStatus,
    ) as undefined | {data: {id: string; status: string}};
    expect(status).to.not.be.undefined();
    expect(status!.data.id).to.equal('tc-9');
    expect(status!.data.status).to.equal(ToolStatus.AwaitingApproval);
  });

  it('maps tripwire chunks to Error events with the processor id and reason', async () => {
    createThread.resolves({id: 't1'});
    stubStreamWith([
      {
        type: 'tripwire',
        payload: {processorId: 'pii-detector', reason: 'email leak'},
      },
    ]);

    const events = await collect(
      makeRunner().run('q', undefined, new AbortController().signal),
    );

    const err = events.find(e => e.type === LLMStreamEventType.Error) as
      | undefined
      | {data: {message: string}};
    expect(err).to.not.be.undefined();
    expect(err!.data.message).to.match(/pii-detector/);
    expect(err!.data.message).to.match(/email leak/);
  });

  it('does NOT write to RunRegistry on suspended finish (HITL resume lands in v3.1)', async () => {
    // ApprovalController is scoped to v3.1 (Phase 4 of the migration
    // plan). Writing to RunRegistry here without a consumer would
    // accumulate unread TTL entries; the dead path is removed in v3.0.
    createThread.resolves({id: 'thread-suspend'});
    stubStreamWith([
      {
        type: 'finish',
        payload: {output: {finishReason: 'suspended'}, runId: 'run-42'},
      },
    ]);

    await collect(
      makeRunner().run('q', undefined, new AbortController().signal),
    );

    expect(await runRegistry.get('thread-suspend')).to.be.undefined();
  });

  it('emits Status events for each uploaded file before streaming', async () => {
    createThread.resolves({id: 't1'});
    stubStreamWith([{type: 'text-delta', payload: {text: '.'}}]);

    const files = [
      {originalname: 'a.pdf'} as Express.Multer.File,
      {originalname: 'b.pdf'} as Express.Multer.File,
    ];
    const events = await collect(
      makeRunner().run('q', files, new AbortController().signal),
    );

    const statusMsgs = events
      .filter(e => e.type === LLMStreamEventType.Status)
      .map(e => (e as {data: string}).data);
    // summariseAndMergeFiles emits one `Reading file: X` per attachment;
    // when no model is bound or the summarisation call rejects (the unit
    // suite has no live LLM) it follows up with a `Failed to read file: X`
    // / `Skipped file: X` entry. Both shapes are valid; assert only on the
    // ordered Reading events so the test stays decoupled from the
    // failure-mode wording.
    const readingMsgs = statusMsgs.filter(m => m.startsWith('Reading file:'));
    expect(readingMsgs).to.eql(['Reading file: a.pdf', 'Reading file: b.pdf']);
  });

  it('uses the ResourceId binding when supplied and falls through to it as the memory resource', async () => {
    createThread.resolves({id: 't1'});
    stubStreamWith([{type: 'text-delta', payload: {text: '.'}}]);

    await collect(
      makeRunner('tenant-a:user-1').run(
        'q',
        undefined,
        new AbortController().signal,
      ),
    );

    sinon.assert.calledWith(
      createThread,
      sinon.match({resourceId: 'tenant-a:user-1'}),
    );
    const streamOpts = streamStub.firstCall.args[1] as {
      memory: {resource: string};
    };
    expect(streamOpts.memory.resource).to.equal('tenant-a:user-1');
  });
});
