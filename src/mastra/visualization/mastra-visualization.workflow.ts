import {BindingScope, inject, injectable, service} from '@loopback/core';
import {IDataSetStore} from '../../components/db-query/types';
import {DbQueryAIExtensionBindings} from '../../components/db-query/keys';
import {AiIntegrationBindings} from '../../keys';
import {LLMProvider} from '../../types';
import {TokenCounter} from '../../services/token-counter.service';
import {MastraDbQueryWorkflow} from '../db-query/mastra-db-query.workflow';
import {
  MastraBarVisualizerService,
  MastraLineVisualizerService,
  MastraPieVisualizerService,
} from './services';
import {
  IMastraVisualizer,
  MastraVisualizationContext,
  MastraVisualizationState,
  VisualizationWorkflowInput,
} from './types/visualization.types';
import {
  callQueryGenerationStep,
  checkPostQueryGenerationConditions,
  checkPostSelectConditions,
  getDatasetDataStep,
  renderVisualizationStep,
  selectVisualizationStep,
} from './workflow';

const debug = require('debug')('mastra:visualization:workflow');

/**
 * Mastra-path imperative workflow for the Visualization feature.
 *
 * Injects all services directly (no class-based node wrappers) and delegates
 * to pure step functions in `workflow/steps/`. This is the exact same pattern
 * used by `MastraDbQueryWorkflow` in Phase 3.
 *
 * ## Flow (mirrors `VisualizationGraph.build()`)
 * ```
 * START
 *   └─ selectVisualization ─┬─ error → END
 *                            └─ continue
 *                                └─ callQueryGeneration ─┬─ error → END
 *                                                         └─ continue
 *                                                             └─ getDatasetData
 *                                                                   └─ renderVisualization → END
 * ```
 *
 * ## Key design decisions
 * - `selectVisualizationStep` resolves the chart type from a list of
 *   `IMastraVisualizer` instances injected directly (no `findByTag` at runtime).
 * - `callQueryGenerationStep` delegates to `MastraDbQueryWorkflow` when no
 *   `datasetId` is provided, forwarding `context.writer` and `context.signal`.
 * - `renderVisualizationStep` calls `visualizer.getConfig()` which uses AI SDK
 *   `generateObject()` — no LangGraph `withStructuredOutput()` anywhere.
 *
 * @injectable `BindingScope.REQUEST` — one instance per HTTP request.
 */
@injectable({scope: BindingScope.REQUEST})
export class MastraVisualizationWorkflow {
  /** All registered Mastra-path visualizers, collected for step injection. */
  private readonly mastraVisualizers: IMastraVisualizer[];

  constructor(
    // ── LLM providers ──────────────────────────────────────────────────────
    @inject(AiIntegrationBindings.AiSdkCheapLLM)
    private readonly cheapLlm: LLMProvider,

    // ── Dataset store ───────────────────────────────────────────────────────
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly datasetStore: IDataSetStore,

    // ── Mastra visualizer services ──────────────────────────────────────────
    @service(MastraBarVisualizerService)
    private readonly barVisualizer: MastraBarVisualizerService,
    @service(MastraLineVisualizerService)
    private readonly lineVisualizer: MastraLineVisualizerService,
    @service(MastraPieVisualizerService)
    private readonly pieVisualizer: MastraPieVisualizerService,

    // ── DbQuery workflow (for generating datasets on-the-fly) ───────────────
    @service(MastraDbQueryWorkflow)
    private readonly dbQueryWorkflow: MastraDbQueryWorkflow,
    @service(TokenCounter)
    private readonly tokenCounter: TokenCounter,
  ) {
    // Collect all visualizers into a flat array for the selection step.
    // New visualizers should be added here AND registered in VisualizerComponent.
    this.mastraVisualizers = [barVisualizer, lineVisualizer, pieVisualizer];
  }

  /**
   * Execute the full Visualization workflow.
   *
   * @param input  User prompt, optional datasetId, and optional chart type hint.
   * @param ctx    Execution context: SSE writer and/or AbortSignal.
   * @returns      Final `MastraVisualizationState` after all steps have run.
   */
  async run(
    input: VisualizationWorkflowInput,
    ctx?: MastraVisualizationContext,
  ): Promise<MastraVisualizationState> {
    const context: MastraVisualizationContext = {
      ...ctx,
      onUsage: (i, o, m) => {
        this.tokenCounter.accumulate(i, o, m);
        if (ctx?.onUsage) ctx.onUsage(i, o, m);
      },
    };

    debug(
      'Workflow START prompt=%s datasetId=%s type=%s',
      input.prompt,
      input.datasetId ?? '(none)',
      input.type ?? '(auto)',
    );

    // ── Initial state ───────────────────────────────────────────────────────
    let state: MastraVisualizationState = {
      prompt: input.prompt,
      datasetId: input.datasetId,
      type: input.type,
    };

    // ── Step 1: SelectVisualization ─────────────────────────────────────────
    debug('Executing step: SelectVisualization');
    state = this.merge(
      state,
      await selectVisualizationStep(state, context, {
        llm: this.cheapLlm,
        visualizers: this.mastraVisualizers,
      }),
    );
    debug(
      'Completed step: SelectVisualization visualizer=%s',
      state.visualizerName ?? state.error,
    );

    // ── Branch: SelectVisualization error? ──────────────────────────────────
    const selectCondition = checkPostSelectConditions(state);
    debug('Branch decision (post-select): %s', selectCondition);

    if (selectCondition === 'error') {
      debug(
        'Workflow END success=false (no matching visualizer: %s)',
        state.error,
      );
      return state;
    }

    // ── Step 2: CallQueryGeneration ─────────────────────────────────────────
    debug('Executing step: CallQueryGeneration');
    state = this.merge(
      state,
      await callQueryGenerationStep(state, context, {
        dbQueryWorkflow: this.dbQueryWorkflow,
      }),
    );
    debug(
      'Completed step: CallQueryGeneration datasetId=%s',
      state.datasetId ?? state.error,
    );

    // ── Branch: CallQueryGeneration error? ──────────────────────────────────
    const queryCondition = checkPostQueryGenerationConditions(state);
    debug('Branch decision (post-query-gen): %s', queryCondition);

    if (queryCondition === 'error') {
      debug(
        'Workflow END success=false (dataset generation failed: %s)',
        state.error,
      );
      return state;
    }

    // ── Step 3: GetDatasetData ──────────────────────────────────────────────
    debug('Executing step: GetDatasetData');
    state = this.merge(
      state,
      await getDatasetDataStep(state, context, {
        store: this.datasetStore,
      }),
    );
    debug('Completed step: GetDatasetData sql=%s', state.sql?.substring(0, 60));

    // ── Step 4: RenderVisualization ─────────────────────────────────────────
    debug('Executing step: RenderVisualization');
    state = this.merge(state, await renderVisualizationStep(state, context));
    debug('Completed step: RenderVisualization done=%s', state.done);

    debug('Workflow END success=true visualizer=%s', state.visualizerName);
    return state;
  }

  /**
   * Shallow-merge one or more partial states into `base`.
   * Last-write-wins per field — same semantics as LangGraph's `Annotation.Root`.
   */
  private merge(
    base: MastraVisualizationState,
    ...partials: Partial<MastraVisualizationState>[]
  ): MastraVisualizationState {
    return Object.assign({}, base, ...partials);
  }
}
