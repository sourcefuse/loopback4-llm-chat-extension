import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {LLMStreamEventType, ToolStatus} from '../../../../types/events';
import {failedStep} from '../../../../mastra/db-query/workflow/steps/failed.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';

describe('failedStep (Mastra)', function () {
  let writerSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  beforeEach(() => {
    writerSpy = sinon.spy();
    context = {writer: writerSpy} as unknown as MastraDbQueryContext;
  });

  it('emits a ToolStatus.Failed writer event', async () => {
    const state = {} as DbQueryState;
    await failedStep(state, context);

    sinon.assert.calledOnce(writerSpy);
    const call = writerSpy.firstCall.args[0];
    expect(call.type).to.equal(LLMStreamEventType.ToolStatus);
    expect(call.data.status).to.equal(ToolStatus.Failed);
  });

  it('returns the existing replyToUser when already set', async () => {
    const state = {
      replyToUser: 'Custom error message',
    } as unknown as DbQueryState;
    const result = await failedStep(state, context);

    expect(result.replyToUser).to.equal('Custom error message');
  });

  it('generates a default replyToUser when not set', async () => {
    const state = {} as DbQueryState;
    const result = await failedStep(state, context);

    expect(result.replyToUser).to.match(/not able to generate a valid SQL/);
  });

  it('includes feedbacks in the default message when provided', async () => {
    const state = {
      feedbacks: ['Table not found', 'Syntax error'],
    } as unknown as DbQueryState;
    const result = await failedStep(state, context);

    expect(result.replyToUser).to.match(/Table not found/);
    expect(result.replyToUser).to.match(/Syntax error/);
  });

  it('produces an empty error list when feedbacks is an empty array', async () => {
    const state = {feedbacks: []} as unknown as DbQueryState;
    const result = await failedStep(state, context);

    expect(result.replyToUser).to.match(/I am sorry/);
    // feedbacks.join('\n') on an empty array produces '' — the trailing newline is present
    expect(result.replyToUser).to.match(
      /These were the errors I encountered:\n$/,
    );
  });

  it('works without a writer in context', async () => {
    const ctxNoWriter = {} as MastraDbQueryContext;
    const state = {} as DbQueryState;
    const result = await failedStep(state, ctxNoWriter);

    expect(result.replyToUser).to.be.a.String();
  });
});
