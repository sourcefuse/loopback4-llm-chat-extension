import {expect} from '@loopback/testlab';
import {ChatController} from '../../controllers/chat.controller';

/**
 * Unit coverage for the ChatController contract mapping — the v2 `Chat` shape
 * consumers (BizBook) depend on, and the message flattening that surfaces a
 * `type:'tool'` message with `existingDatasetId` so "Load Dataset" / re-run
 * from history works. Drives the controller with a fake Mastra Memory.
 */
describe('ChatController (unit)', () => {
  const user = {id: 'u1', userTenantId: 'ut1', tenantId: 't1'};
  // deriveResourceId(user) => `${tenantId}:${principal}`; principal prefers
  // userTenantId (v2 ownership convention).
  const resourceId = 't1:ut1';

  // A Mastra assistant turn: reasoning + a tool-invocation (with a dataset-id
  // readout) + final text — all bundled in one message's content.parts.
  const assistantToolMsg = {
    id: 'm2',
    role: 'assistant',
    createdAt: '2026-06-04T10:00:01.000Z',
    content: {
      format: 2,
      parts: [
        {
          type: 'reasoning',
          reasoning: '',
          details: [{type: 'text', text: 'thinking'}],
        },
        {
          type: 'tool-invocation',
          toolInvocation: {
            state: 'result',
            toolCallId: 'call_1',
            toolName: 'get-data-as-dataset',
            args: {prompt: 'list employees joined in 2024'},
            result:
              'Dataset generated and has been rendered for the user (dataset ID 279). The task is COMPLETE.',
          },
        },
        {type: 'text', text: 'Here is the list. Let me know if you need more.'},
      ],
    },
  };
  const userMsg = {
    id: 'm1',
    role: 'user',
    createdAt: '2026-06-04T10:00:00.000Z',
    content: {parts: [{type: 'text', text: 'list employees joined in 2024'}]},
  };

  const thread = {
    id: 'thread1',
    resourceId,
    title: 'list employees joined in 2024',
    metadata: {inputTokens: 8208, outputTokens: 276},
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:25.000Z',
  };

  const memory = {
    listThreads: async () => ({threads: [thread]}),
    getThreadById: async () => thread,
    recall: async () => ({messages: [userMsg, assistantToolMsg]}),
  };
  const mastra = {getAgent: () => ({getMemory: async () => memory})};
  const controller = new ChatController(
    mastra as never,
    undefined,
    user as never,
  );

  it('GET /chats maps to the v2 Chat shape (tenant/user, tokens, createdOn)', async () => {
    const [chat] = (await controller.find()) as Array<Record<string, unknown>>;
    expect(chat.id).to.equal('thread1');
    expect(chat.tenantId).to.equal('t1');
    expect(chat.userId).to.equal('ut1');
    expect(chat.title).to.equal('list employees joined in 2024');
    expect(chat.inputTokens).to.equal(8208);
    expect(chat.outputTokens).to.equal(276);
    expect(chat.createdOn).to.equal('2026-06-04T10:00:00.000Z');
    expect(chat.modifiedOn).to.equal('2026-06-04T10:00:25.000Z');
  });

  it('GET /chats/{id} flattens a tool-invocation into a type:tool message with existingDatasetId', async () => {
    const res = (await controller.findById('thread1')) as {
      messages: Array<Record<string, unknown>>;
    };
    const tool = res.messages.find(m => m.type === 'tool');
    expect(tool).to.not.be.undefined();
    const meta = tool!.metadata as Record<string, unknown>;
    expect(meta.type).to.equal('tool');
    expect(meta.toolName).to.equal('get-data-as-dataset');
    expect(meta.existingDatasetId).to.equal('279');
    expect(meta.status).to.equal('success');
    expect((meta.args as Record<string, unknown>).prompt).to.match(/2024/);
    // the user prompt + the assistant's final text are present as user/ai msgs
    const types = res.messages.map(m => m.type);
    expect(types).to.containEql('user');
    expect(types).to.containEql('ai');
    expect(types).to.containEql('tool');
    const ai = res.messages.find(m => m.type === 'ai');
    expect(ai!.body).to.match(/Here is the list/);
  });

  it('surfaces visualization + config from an object tool-result (chart re-render)', async () => {
    const vizMsg = {
      id: 'mv',
      role: 'assistant',
      createdAt: '2026-06-04T10:00:02.000Z',
      content: {
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'callv',
              toolName: 'generate-visualization',
              args: {type: 'line', prompt: 'salary over time'},
              result: {
                visualization: 'line',
                chartConfig: {
                  xAxisColumn: 'joining_date',
                  yAxisColumn: 'salary',
                },
                datasetId: '293',
                sql: 'SELECT ...',
              },
            },
          },
        ],
      },
    };
    const mem = {...memory, recall: async () => ({messages: [vizMsg]})};
    const c = new ChatController(
      {getAgent: () => ({getMemory: async () => mem})} as never,
      undefined,
      user as never,
    );
    const res = (await c.findById('thread1')) as {
      messages: Array<Record<string, unknown>>;
    };
    const tool = res.messages.find(m => m.type === 'tool');
    const meta = tool!.metadata as Record<string, unknown>;
    expect(meta.toolName).to.equal('generate-visualization');
    expect(meta.visualization).to.equal('line');
    expect(meta.existingDatasetId).to.equal('293');
    expect((meta.config as Record<string, unknown>).xAxisColumn).to.equal(
      'joining_date',
    );
  });

  it('GET /chats/{id} 404s a thread the requester does not own', async () => {
    const otherMem = {
      ...memory,
      getThreadById: async () => ({...thread, resourceId: 'other:user'}),
    };
    const c = new ChatController(
      {getAgent: () => ({getMemory: async () => otherMem})} as never,
      undefined,
      user as never,
    );
    await expect(c.findById('thread1')).to.be.rejectedWith(/not found/);
  });
});
