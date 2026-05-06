import {BindingScope, inject, injectable, service} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
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
import {adaptMastraEvent} from '../workflow-event-adapter';
import {
  runSelectVisualization,
  runCallQueryGeneration,
  runGetDatasetData,
  runRenderVisualization,
  checkPostSelectConditions,
  checkPostQueryGenerationConditions,
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
    @inject(AiIntegrationBindings.LangfuseMastraClient, {optional: true})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly langfuse: any | undefined,
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
    const context = this.buildContext(ctx);
    const initialState: MastraVisualizationState = {
      prompt: input.prompt,
      datasetId: input.datasetId,
      type: input.type,
    };

    // ── Per-request bound steps (close over context + this.* deps) ──────────

    const selectBound = createStep({
      id: 'visualization-select-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: MastraVisualizationState & {workflowDone?: boolean};
      }) => {
        debug('Executing step: SelectVisualization');
        const partial = await runSelectVisualization(inputData, context, {
          llm: this.cheapLlm,
          visualizers: this.mastraVisualizers,
        });
        const next = this.merge(inputData, partial);
        debug(
          'Completed step: SelectVisualization visualizer=%s',
          next.visualizerName ?? next.error,
        );

        const selectCondition = checkPostSelectConditions(next);
        debug('Branch decision (post-select): %s', selectCondition);
        if (selectCondition === 'error') {
          debug(
            'Workflow END success=false (no matching visualizer: %s)',
            next.error,
          );
          return {...next, workflowDone: true};
        }
        return next;
      },
    });

    const callQueryGenBound = createStep({
      id: 'visualization-call-query-gen-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: MastraVisualizationState & {workflowDone?: boolean};
      }) => {
        if (inputData.workflowDone) return inputData;
        debug('Executing step: CallQueryGeneration');
        const partial = await runCallQueryGeneration(inputData, context, {
          dbQueryWorkflow: this.dbQueryWorkflow,
        });
        const next = this.merge(inputData, partial);
        debug(
          'Completed step: CallQueryGeneration datasetId=%s',
          next.datasetId ?? next.error,
        );

        const queryCondition = checkPostQueryGenerationConditions(next);
        debug('Branch decision (post-query-gen): %s', queryCondition);
        if (queryCondition === 'error') {
          debug(
            'Workflow END success=false (dataset generation failed: %s)',
            next.error,
          );
          return {...next, workflowDone: true};
        }
        return next;
      },
    });

    const getDatasetDataBound = createStep({
      id: 'visualization-get-dataset-data-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: MastraVisualizationState & {workflowDone?: boolean};
      }) => {
        if (inputData.workflowDone) return inputData;
        debug('Executing step: GetDatasetData');
        const partial = await runGetDatasetData(inputData, context, {
          store: this.datasetStore,
        });
        const next = this.merge(inputData, partial);
        debug(
          'Completed step: GetDatasetData sql=%s',
          next.sql?.substring(0, 60),
        );
        return next;
      },
    });

    const renderBound = createStep({
      id: 'visualization-render-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: MastraVisualizationState & {workflowDone?: boolean};
      }) => {
        if (inputData.workflowDone) return inputData;
        debug('Executing step: RenderVisualization');
        const partial = await runRenderVisualization(inputData, context);
        const next = this.merge(inputData, partial);
        debug('Completed step: RenderVisualization done=%s', next.done);
        debug('Workflow END success=true visualizer=%s', next.visualizerName);
        return {...next, workflowDone: true};
      },
    });

    // ── Build and run Mastra workflow DSL ────────────────────────────────────
    const workflow = createWorkflow({
      id: 'visualization',
      inputSchema: z.any(),
      outputSchema: z.any(),
    })
      .then(selectBound)
      .then(callQueryGenBound)
      .then(getDatasetDataBound)
      .then(renderBound)
      .commit();

    const run = await workflow.createRun();
    const result = await run.start({inputData: initialState});
    if (result.status === 'success') {
      const finalState = result.result as MastraVisualizationState & {
        workflowDone?: boolean;
      };
      delete finalState.workflowDone;
      return finalState;
    }
    return initialState;
  }

  private buildContext(
    ctx?: MastraVisualizationContext,
  ): MastraVisualizationContext {
    const emit = (chunk: unknown) => {
      const adapted = adaptMastraEvent(chunk);
      ctx?.emit?.(adapted);
      ctx?.writer?.(adapted);
    };

    return {
      ...ctx,
      emit,
      writer: emit,
      onUsage: (i, o, m) => {
        this.tokenCounter.accumulate(i, o, m);
        if (ctx?.onUsage) ctx.onUsage(i, o, m);
      },
      langfuse: this.langfuse,
    };
  }

  /**
   * Shallow-merge one or more partial states into `base`.
   * Last-write-wins per field.
   */
  private merge(
    base: MastraVisualizationState,
    ...partials: Partial<MastraVisualizationState>[]
  ): MastraVisualizationState {
    return Object.assign({}, base, ...partials);
  }
}
