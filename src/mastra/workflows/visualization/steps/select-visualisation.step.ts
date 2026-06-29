import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  emitToolStatus,
  getCheapLlm,
  getDatasetStore,
  getVisualizers,
  tracedGenerateText,
} from '../../db-query/_helpers';
import type {IVisualizer} from '../../../../components/visualization/types';
import {
  buildVisualizerSelectionPrompt,
  DEFAULT_CHART_TYPE,
  fetchDatasetDescriptor,
  parseVisualizerSelection,
  type VisualizationDataContext,
  type VisualizerSelection,
} from './shared';

const STEP_SELECT_VISUALISATION = 'select-visualisation';

/**
 * Ask the LLM to pick the best-fitting visualizer for the request AND the data
 * it returns, or to reject when none fit. Restores the v2
 * select-visualization.node behaviour: the model chooses among the registered
 * visualizers (using each one's description + data requirements) AND the SQL +
 * description of the dataset being charted — not blindly from the request text.
 * Infra failures fall back to the first visualizer so a flaky LLM never fails
 * the whole run.
 */
async function selectViaLlm(
  userQuery: string,
  visualizers: IVisualizer[],
  llm: Parameters<typeof tracedGenerateText>[0]['model'] | undefined,
  tracing: Parameters<typeof tracedGenerateText>[0]['tracing'],
  data: VisualizationDataContext,
): Promise<VisualizerSelection> {
  if (!llm) return {chartType: visualizers[0].name};
  try {
    const result = await tracedGenerateText({
      model: llm,
      prompt: buildVisualizerSelectionPrompt(userQuery, visualizers, data),
      tracing,
      label: STEP_SELECT_VISUALISATION,
      resultType: 'planning',
    });
    return parseVisualizerSelection(result.text, visualizers);
  } catch {
    return {chartType: visualizers[0].name};
  }
}

export const selectVisualisationStep = createStep({
  id: STEP_SELECT_VISUALISATION,
  inputSchema: z.object({
    datasetId: z.string(),
    userQuery: z.string(),
    type: z.string().optional(),
  }),
  outputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
    userQuery: z.string(),
    // Set when the LLM rejected every registered visualizer ("none" path).
    // Threaded through the remaining steps so they short-circuit instead of
    // forcing an unsuitable chart.
    rejected: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, tracingContext}) => {
    emitToolStatus(
      requestContext,
      STEP_SELECT_VISUALISATION,
      'Selecting best visualization for the data',
    );

    const needsQuery = !inputData.datasetId;
    const base = {
      datasetId: inputData.datasetId,
      needsQuery,
      userQuery: inputData.userQuery,
    };

    // An explicit `type` from the caller wins — the user/agent has already
    // chosen the chart, so skip the selection LLM call.
    if (inputData.type) {
      return {...base, chartType: inputData.type};
    }

    const visualizers = getVisualizers(requestContext);
    if (visualizers.length === 0) {
      return {...base, chartType: DEFAULT_CHART_TYPE};
    }

    // Charting an EXISTING dataset → feed its SQL + description so the model
    // matches the chart to the data shape (v2 select-visualization.node). For a
    // fresh request (no datasetId yet) the query hasn't run, so the model picks
    // from the request text (the downstream query-gen then shapes the data).
    let data: VisualizationDataContext = {};
    if (inputData.datasetId) {
      data = await fetchDatasetDescriptor(
        getDatasetStore(requestContext),
        inputData.datasetId,
      );
    }

    const selection = await selectViaLlm(
      inputData.userQuery,
      visualizers,
      getCheapLlm(requestContext),
      tracingContext,
      data,
    );

    if ('rejected' in selection) {
      return {...base, chartType: '', rejected: true, reason: selection.reason};
    }
    return {...base, chartType: selection.chartType};
  },
});
