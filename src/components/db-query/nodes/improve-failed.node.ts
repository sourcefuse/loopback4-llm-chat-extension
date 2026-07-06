import {graphNode} from '../../../decorators';
import type {IGraphNode} from '../../../graphs/types';
import type {ImproveOut} from '../types';
import {DbQueryNodes} from '../nodes.enum';

/**
 * Terminal failure step for the improve workflow (successor of the LangGraph
 * improve FailedNode). Its Mastra step id is `'failed'` within the improve
 * workflow, but its DI resolver key is the distinct `'improve-failed'`
 * (DbQueryNodes.ImproveFailed) so it never collides with the generate `failed` step.
 */
@graphNode(DbQueryNodes.ImproveFailed)
export class ImproveFailedNode implements IGraphNode<unknown, ImproveOut> {
  async execute(): Promise<ImproveOut> {
    return {datasetId: '', sql: ''};
  }
}
