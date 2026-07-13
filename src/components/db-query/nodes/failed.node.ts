import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import type {FailedOut} from '../types';
import {DbQueryNodes} from '../nodes.enum';

/**
 * Terminal failure node (the successor of the LangGraph FailedNode). DI resolver
 * key `'failed'` (DbQueryNodes.Failed); its Mastra step id is also `'failed'`.
 * The improve workflow's terminal node shares the Mastra id but is registered
 * under the distinct key `'improve-failed'`.
 *
 * The message-building logic lives on the class so a host can `extends
 * FailedNode` and override `buildFailureMessage` (or `genericFailure`) to
 * customise the user-facing copy, then rebind under `@graphNode(DbQueryNodes.Failed)`.
 */
@graphNode(DbQueryNodes.Failed)
export class FailedNode implements IGraphNode<unknown, FailedOut> {
  protected readonly genericFailure =
    "I wasn't able to generate a valid SQL query for that request. " +
    'Please try rephrasing it or adding more detail.';

  async execute({inputData}: GraphNodeCtx): Promise<FailedOut> {
    const data = (inputData ?? {}) as {replyToUser?: string; feedback?: string};
    // datasetId/sql stay empty (no dataset was produced); the message is what
    // the tool forwards to the agent so the user always gets a reason.
    return {
      datasetId: '',
      sql: '',
      replyToUser: this.buildFailureMessage(data),
    };
  }

  /**
   * Build the user-facing failure message (restores v2 FailedNode). Priority:
   *   1. an upstream `replyToUser` (e.g. the unanswerable-question gate),
   *   2. the last validation `feedback` summarised into an apology,
   *   3. a generic rephrase prompt.
   */
  protected buildFailureMessage(data: {
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
    return this.genericFailure;
  }
}
