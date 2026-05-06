import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType, ToolStatus} from '../../../../types/events';
import {
  MastraVisualizationContext,
  MastraVisualizationState,
} from '../../types/visualization.types';

const debug = require('debug')(
  'ai-integration:mastra:visualization:render-visualization',
);

/**
 * `renderVisualizationStep` has no extra dependencies beyond the state and
 * context — the visualizer instance is already resolved in `state.visualizer`
 * by `selectVisualizationStep`.
 */
export type RenderVisualizationStepDeps = Record<string, never>;

/**
 * Plain async function containing the business logic — callable without
 * the Mastra workflow runtime. Used by the workflow DSL directly.
 */
export async function runRenderVisualization(
  state: MastraVisualizationState,
  context: MastraVisualizationContext,
): Promise<Partial<MastraVisualizationState>> {
  debug('step start visualizer=%s', state.visualizerName);

  const visualizer = state.visualizer;

  if (!visualizer || !state.sql || !state.queryDescription) {
    throw new Error(
      'renderVisualizationStep: Invalid State — visualizer, sql, and queryDescription are all required',
    );
  }

  context.emit?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: `Configuring ${visualizer.name}`},
  });

  debug('Calling visualizer.getConfig() for %s', visualizer.name);
  const settings = await visualizer.getConfig(
    state,
    context.onUsage,
    context.langfuse,
  );
  debug('Visualizer config generated: %o', settings);

  context.emit?.({
    type: LLMStreamEventType.ToolStatus,
    data: {
      status: ToolStatus.Completed,
      data: {
        datasetId: state.datasetId,
        visualization: visualizer.name,
        config: settings ?? {},
      },
    },
  });

  return {
    done: true,
    visualizerConfig: settings ?? {},
  };
}

/**
 * Renders the final chart configuration by calling the resolved visualizer's
 * `getConfig()` method.
 *
 * Two SSE events are emitted:
 * 1. `ToolStatus` — "Configuring <name>" — signals the frontend that rendering
 *    has started.
 * 2. `ToolStatus` — `ToolStatus.Completed` — delivers the final chart config
 *    (datasetId, visualization name, and config object) for the UI to render.
 *
 * Returns `{ done: true, visualizerConfig }` on success.
 *
 * Mirrors `RenderVisualizationNode.execute()` in the LangGraph path.
 * LangGraph coupling removed: `LangGraphRunnableConfig` → `MastraVisualizationContext`.
 */
export const renderVisualizationStep = createStep({
  id: 'visualization-render',
  inputSchema: z.any(),
  outputSchema: z.any(),
  execute: async ({
    inputData,
  }: {
    inputData: {
      state: MastraVisualizationState;
      context: MastraVisualizationContext;
    };
  }): Promise<Partial<MastraVisualizationState>> => {
    const {state, context} = inputData;
    return runRenderVisualization(state, context);
  },
});
