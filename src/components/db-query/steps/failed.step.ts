import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {STEP_FAILED} from './constants';

const GENERIC_FAILURE =
  "I wasn't able to generate a valid SQL query for that request. " +
  'Please try rephrasing it or adding more detail.';

/**
 * Build the user-facing failure message (restores v2 FailedNode). Priority:
 *   1. an upstream `replyToUser` (e.g. the unanswerable-question gate),
 *   2. the last validation `feedback` summarised into an apology,
 *   3. a generic rephrase prompt.
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

type FailedOut = {datasetId: string; sql: string; replyToUser: string};

/**
 * Terminal failure step (the Mastra-named successor of the LangGraph
 * FailedNode). DI resolver key `'failed'` (STEP_FAILED); its Mastra step id is
 * also `'failed'`. The improve workflow's terminal step shares the Mastra id
 * but is registered under the distinct key `'improve-failed'`.
 */
@step(STEP_FAILED)
export class FailedStep implements IWorkflowStep<unknown, FailedOut> {
  async execute({inputData}: WorkflowStepCtx): Promise<FailedOut> {
    const data = (inputData ?? {}) as {replyToUser?: string; feedback?: string};
    // datasetId/sql stay empty (no dataset was produced); the message is what
    // the tool forwards to the agent so the user always gets a reason.
    return {datasetId: '', sql: '', replyToUser: buildFailureMessage(data)};
  }
}
