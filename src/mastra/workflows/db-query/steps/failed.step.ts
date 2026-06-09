import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {outputSchema} from './constants';

const GENERIC_FAILURE =
  "I wasn't able to generate a valid SQL query for that request. " +
  'Please try rephrasing it or adding more detail.';

/**
 * Build the user-facing failure message (restores v2 FailedNode). Priority:
 *   1. an upstream `replyToUser` (e.g. the unanswerable-question gate),
 *   2. the last validation `feedback` summarised into an apology,
 *   3. a generic rephrase prompt.
 * Without this the user receives a silent empty dataset on every failure.
 */
function buildFailureMessage(data: {
  replyToUser?: string;
  feedback?: string;
}): string {
  if (data.replyToUser) return data.replyToUser;
  const feedback = data.feedback?.trim();
  if (feedback) {
    return (
      "I wasn't able to generate a valid SQL query for that request. " +
      `These were the errors I encountered:\n${feedback}`
    );
  }
  return GENERIC_FAILURE;
}

export const failedStep = createStep({
  id: 'failed',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData}) => {
    const data = (inputData ?? {}) as {replyToUser?: string; feedback?: string};
    // datasetId/sql stay empty (no dataset was produced); the message is what
    // the tool forwards to the agent so the user always gets a reason.
    return {datasetId: '', sql: '', replyToUser: buildFailureMessage(data)};
  },
});
