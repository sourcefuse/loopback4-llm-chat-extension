import {expect} from '@loopback/testlab';
import {Mastra} from '@mastra/core';
import {Agent} from '@mastra/core/agent';
import {LibSQLStore} from '@mastra/libsql';
import {Memory} from '@mastra/memory';
// Mastra ships `createMockModel` at @mastra/core/test-utils/llm-mock but
// forgets the .d.ts file — the ambient module declaration in
// src/__tests__/integration/mastra-test-utils.d.ts tells TS the export
// shape so this integration test compiles. JS resolves fine at runtime.
// The doc's `MockLanguageModelV2` name was outdated; the real class is
// `MastraLanguageModelV2Mock`, but the `createMockModel` factory is the
// supported entrypoint.
import {createMockModel} from '@mastra/core/test-utils/llm-mock';
import {ChatGraph} from '../../graphs/chat/chat.graph';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import {UsageAccumulator} from '../../services/usage-accumulator.service';
import {makeChatGraph} from '../fixtures/chat-graph-context';

// ChatGraph streams the chatAgent registered on this Mastra instance
// (via getAgent), so the registered agent's static mock model drives output.
// Env var is set defensively; the registered agent never reads it here.
process.env.MASTRA_DEFAULT_CHAT_MODEL ??= 'mock/test-model';

/**
 * End-to-end integration: real Mastra + real Memory + real LibSQL
 * (in-memory) driven by Mastra's stock MockLanguageModelV2. Verifies the
 * full ChatGraph.execute() pipeline maps fullStream chunks to the SSE
 * wire contract without any sinon stubs.
 *
 * If Mastra renames a chunk type ('text-delta' / 'tool-call' / 'finish')
 * or shifts the fullStream payload shape between minor versions, this
 * test catches it before ChatGraph is exercised in production.
 */
describe('ChatGraph Agent Integration', () => {
  const requesterResourceId = 'tenant-integration:user-integration';
  let storage: LibSQLStore;
  let mastra: Mastra;
  let runner: ChatGraph;
  let usage: UsageAccumulator;

  beforeEach(async () => {
    storage = new LibSQLStore({id: 'integration', url: ':memory:'});
    const memory = new Memory({
      storage,
      vector: false,
      options: {
        lastMessages: 20,
        semanticRecall: false,
        workingMemory: {enabled: false},
        generateTitle: false,
      },
    });
    const chatAgent = new Agent({
      id: 'chat-agent',
      name: 'ChatAgent',
      instructions: 'Test agent',
      model: makeMockModel('Hello world') as never,
      tools: {},
      memory,
    });
    mastra = new Mastra({
      agents: {chatAgent},
      workflows: {},
      storage,
    });
    usage = new UsageAccumulator();
    runner = makeChatGraph({
      mastra,
      usage,
      resourceId: requesterResourceId,
      chatLlm: makeMockModel('Hello world'),
    }).chatGraph;
  });

  async function collect(
    iter: AsyncIterable<LLMStreamEvent>,
  ): Promise<LLMStreamEvent[]> {
    const out: LLMStreamEvent[] = [];
    for await (const event of iter) out.push(event);
    return out;
  }

  it('streams Init, Message chunks and TokenCount end-to-end against a real Mastra Agent', async () => {
    const events = await collect(
      runner.execute('hello', undefined, new AbortController().signal),
    );

    const types = events.map(e => e.type);
    expect(types[0]).to.equal(LLMStreamEventType.Init);
    expect(types).to.containEql(LLMStreamEventType.Message);
    expect(types[types.length - 1]).to.equal(LLMStreamEventType.TokenCount);

    const messages = events
      .filter(e => e.type === LLMStreamEventType.Message)
      .map(e => (e as {data: {message: string}}).data.message)
      .join('');
    expect(messages).to.equal('Hello world');

    const tokenCount = events.find(
      e => e.type === LLMStreamEventType.TokenCount,
    ) as {data: {inputTokens: number; outputTokens: number}} | undefined;
    expect(tokenCount).to.not.be.undefined();
    // Usage is bucketed under the real model id now (not a hardcoded
    // 'chat-llm'); a no-file chat turn has exactly one bucket.
    expect(Object.values(usage.flush())).to.eql([
      {
        input: tokenCount!.data.inputTokens,
        output: tokenCount!.data.outputTokens,
      },
    ]);
  });

  it('persists a Mastra thread and resumes it on the second run', async () => {
    const first = await collect(
      runner.execute('first turn', undefined, new AbortController().signal),
    );
    const sessionId = (
      first.find(e => e.type === LLMStreamEventType.Init) as {
        data: {sessionId: string};
      }
    ).data.sessionId;
    expect(sessionId).to.be.a.String();

    // Fresh runner sharing the same Mastra instance — Memory + storage stay alive.
    const runner2 = makeChatGraph({
      mastra,
      usage,
      resourceId: requesterResourceId,
      chatLlm: makeMockModel('Hello world'),
    }).chatGraph;
    const second = await collect(
      runner2.execute(
        'second turn',
        undefined,
        new AbortController().signal,
        sessionId,
      ),
    );

    // No Init on resume — sessionId provided, thread reused.
    expect(second.map(e => e.type)).to.not.containEql(LLMStreamEventType.Init);
    // Thread is the same row in libsql.
    const memory = await mastra.getAgent('chatAgent')?.getMemory();
    const thread = await memory?.getThreadById({threadId: sessionId});
    expect(thread?.id).to.equal(sessionId);
  });
});

/**
 * Build a deterministic V2 mock language model emitting the supplied
 * text. Mastra's createMockModel handles the V2 chunk shape internals
 * (text-delta, finish, usage) so the test stays insulated from
 * AI SDK chunk-format churn.
 */
function makeMockModel(text: string) {
  return createMockModel({mockText: text, version: 'v2'});
}
