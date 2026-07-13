import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {
  asRecord,
  pickBranchOutput,
  readString,
} from '../../../graphs/tool-event.util';
import {DbQueryNodes} from '../nodes.enum';

/**
 * Entry dispatch for the single `dbQueryGraph` — the Mastra successor of the
 * LangGraph `IsImprovementNode`, which sat at `START` of the one `DbQueryGraph`
 * and routed generate-vs-improve. Here it runs the appropriate sub-graph
 * (`generateQueryGraph` when no `datasetId`, `improveQueryGraph` when present),
 * forwarding the request context + tracing so the nested run shares this run's
 * DI node resolver and trace, then normalises the branch-wrapped result to the
 * flat `{datasetId, sql, replyToUser?}` contract the tools read.
 *
 * DI-resolved `@graphNode` class: a host can `extends IsImprovementNode` and
 * override `targetGraph()` (the routing policy) or `normalize()`, then rebind
 * under `@graphNode(DbQueryNodes.IsImprovement)`.
 */
@graphNode(DbQueryNodes.IsImprovement)
export class IsImprovementNode implements IGraphNode {
  async execute({
    inputData,
    mastra,
    requestContext,
    tracingContext,
  }: GraphNodeCtx) {
    const data = inputData as {prompt?: string; datasetId?: string};
    const isImprovement = !!data.datasetId;
    const target = this.targetGraph(data.datasetId);

    const workflow = mastra?.getWorkflow(target);
    if (!workflow) {
      throw new Error(
        `${target} not registered in Mastra — check Provider workflows config`,
      );
    }

    const run = await workflow.createRun();
    const result = await run.start({
      // generate wants {prompt}; improve wants {datasetId, prompt}. Passing the
      // superset is safe (the sub-graph's input schema keeps what it needs).
      inputData: isImprovement
        ? {datasetId: data.datasetId, prompt: data.prompt ?? ''}
        : {prompt: data.prompt ?? ''},
      requestContext,
      tracing: tracingContext,
    });

    // HITL suspension is not wired end-to-end until v3.1; a nested suspend
    // surfaces here as an empty result (the tool then reports it as failed)
    // rather than propagating an approval pause through the parent run.
    if (result.status !== 'success') {
      return {datasetId: '', sql: '', replyToUser: undefined};
    }
    return this.normalize(result.result);
  }

  /** Which sub-graph handles this request. Overridable routing seam. */
  protected targetGraph(datasetId?: string): string {
    return datasetId ? 'improveQueryGraph' : 'generateQueryGraph';
  }

  /**
   * Flatten a sub-graph's branch-wrapped result (`{[save|failed]: {...}}`) to
   * the flat db-query contract. Handles both the generate (`save_dataset`) and
   * improve (`save_improved`) terminal keys. Overridable.
   */
  protected normalize(rawResult: unknown): {
    datasetId: string;
    sql: string;
    replyToUser?: string;
  } {
    const wrapped = asRecord(rawResult);
    const saveResult = asRecord(
      wrapped[DbQueryNodes.SaveDataset] ?? wrapped[DbQueryNodes.SaveImproved],
    );
    const failedResult = asRecord(wrapped[DbQueryNodes.Failed]);
    const out = pickBranchOutput(saveResult, failedResult, wrapped);
    return {
      datasetId: readString(out.datasetId) ?? '',
      sql: readString(out.sql) ?? '',
      replyToUser: readString(out.replyToUser),
    };
  }
}
