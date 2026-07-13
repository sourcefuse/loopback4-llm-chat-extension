import {expect, sinon} from '@loopback/testlab';
import {ChatLedgerService} from '../../services/chat-ledger.service';
import type {ChatRepository} from '../../repositories';

/**
 * The chats ledger is what the token/chat LIMIT STRATEGIES read. The Mastra
 * runtime moved usage to Memory thread metadata, leaving the chats table empty
 * so caps never fired; ChatLedgerService restores the per-session row. These
 * lock the upsert: create on first turn, accumulate after, never throw, and
 * no-op with no repository bound.
 */
describe('ChatLedgerService (B1 token-cap ledger)', () => {
  const row = {id: 'thread-1', tenantId: 't1', userId: 'ut1', title: 'Hi'};
  const svc = (repo?: Partial<ChatRepository>) =>
    new ChatLedgerService(repo as ChatRepository | undefined);

  it('creates a row seeded with the turn usage when none exists', async () => {
    const find = sinon.stub().resolves([]);
    const create = sinon.stub().resolves();
    const updateById = sinon.stub().resolves();

    await svc({find, create, updateById} as unknown as ChatRepository).upsert(
      row,
      100,
      20,
    );

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

    await svc({find, create, updateById} as unknown as ChatRepository).upsert(
      row,
      5,
      3,
    );

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

    // must resolve, not reject
    await svc({find, create, updateById} as unknown as ChatRepository).upsert(
      row,
      1,
      1,
    );
    sinon.assert.calledOnce(create);
  });

  it('no-ops when no ChatRepository is bound', async () => {
    // A consumer without the chats table gets a silent skip, not a crash.
    await svc(undefined).upsert(row, 1, 1);
  });
});
