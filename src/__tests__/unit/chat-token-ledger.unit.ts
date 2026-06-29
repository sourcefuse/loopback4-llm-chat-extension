import {expect, sinon} from '@loopback/testlab';
import {
  upsertChatTokenLedger,
  type ChatLedgerRepo,
} from '../../runtime/chat-token-ledger';

/**
 * The chats ledger is what the token/chat LIMIT STRATEGIES read. The Mastra
 * runtime moved usage to Memory thread metadata, leaving the chats table empty
 * so caps never fired; this restores the per-session row. These lock the
 * upsert: create on first turn, accumulate after, never throw.
 */
describe('upsertChatTokenLedger (B1 token-cap ledger)', () => {
  const row = {id: 'thread-1', tenantId: 't1', userId: 'ut1', title: 'Hi'};

  it('creates a row seeded with the turn usage when none exists', async () => {
    const find = sinon.stub().resolves([]);
    const create = sinon.stub().resolves();
    const updateById = sinon.stub().resolves();
    const repo = {find, create, updateById} as unknown as ChatLedgerRepo;

    await upsertChatTokenLedger(repo, row, 100, 20);

    sinon.assert.notCalled(updateById);
    sinon.assert.calledOnce(create);
    const created = create.firstCall.args[0] as Record<string, unknown>;
    expect(created.id).to.equal('thread-1');
    expect(created.tenantId).to.equal('t1');
    expect(created.userId).to.equal('ut1');
    expect(created.inputTokens).to.equal(100);
    expect(created.outputTokens).to.equal(20);
  });

  it('accumulates onto the existing row', async () => {
    const find = sinon.stub().resolves([{inputTokens: 100, outputTokens: 20}]);
    const create = sinon.stub().resolves();
    const updateById = sinon.stub().resolves();
    const repo = {find, create, updateById} as unknown as ChatLedgerRepo;

    await upsertChatTokenLedger(repo, row, 5, 3);

    sinon.assert.notCalled(create);
    sinon.assert.calledOnce(updateById);
    expect(updateById.firstCall.args[1]).to.eql({
      inputTokens: 105,
      outputTokens: 23,
    });
  });

  it('is best-effort: a repository failure never throws', async () => {
    const find = sinon.stub().rejects(new Error('db down'));
    const create = sinon.stub().rejects(new Error('db down'));
    const updateById = sinon.stub().resolves();
    const repo = {find, create, updateById} as unknown as ChatLedgerRepo;

    await upsertChatTokenLedger(repo, row, 1, 1); // must resolve, not reject
    sinon.assert.calledOnce(create);
  });
});
