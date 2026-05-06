import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {DbQueryState} from '../../../../components/db-query/state';
import {LLMStreamEventType, ToolStatus} from '../../../../types/events';
import {MastraDbQueryContext} from '../../types/db-query.types';

const debug = require('debug')('ai-integration:mastra:db-query:failed');

/**
 * Plain async function containing the business logic — callable without
 * the Mastra workflow runtime. Used by the workflow DSL directly.
 */
export async function runFailed(
  state: DbQueryState,
  context: MastraDbQueryContext,
): Promise<Partial<DbQueryState>> {
  debug('step start', {feedbacks: state.feedbacks});

  const emit = context.emit;

  emit?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: ToolStatus.Failed},
  });

  const result: Partial<DbQueryState> = {
    replyToUser:
      state.replyToUser ??
      `I am sorry, I was not able to generate a valid SQL query for your request. ` +
        `Please try again with a more detailed or a more specific prompt.\n` +
        `These were the errors I encountered:\n${state.feedbacks?.join('\n') ?? 'No errors reported.'}`,
  };

  debug('step result', result);
  return result;
}

/**
 * Emits a `ToolStatus.Failed` SSE event and ensures `state.replyToUser` is
 * set to a human-readable error summary. No LLM call is made.
 */
export const failedStep = createStep({
  id: 'db-query-failed',
  inputSchema: z.any(),
  outputSchema: z.any(),
  execute: async ({
    inputData,
  }: {
    inputData: {state: DbQueryState; context: MastraDbQueryContext};
  }): Promise<Partial<DbQueryState>> => {
    const {state, context} = inputData;
    return runFailed(state, context);
  },
});
