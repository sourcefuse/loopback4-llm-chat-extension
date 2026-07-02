import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../../db-query/keys';
import {
  emitToolStatus,
  tracedGenerateText,
} from '../../db-query/steps/_helpers';
import type {IDataSetStore} from '../../db-query/types';
import {VISUALIZATION_KEY} from '../keys';
import type {IVisualizer} from '../types';
import {
  buildVisualizerSelectionPrompt,
  DEFAULT_CHART_TYPE,
  fetchDatasetDescriptor,
  parseVisualizerSelection,
  STEP_SELECT_VISUALISATION,
  type VisualizationDataContext,
  type VisualizerSelection,
} from './shared';

/**
 * Ask the LLM to pick the best-fitting visualizer for the request AND the data
 * it returns, or to reject when none fit. Restores the v2
 * select-visualization.node behaviour. Infra failures fall back to the first
 * visualizer so a flaky LLM never fails the whole run.
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

type SelectIn = {datasetId: string; userQuery: string; type?: string};

/**
 * Visualizer selection (the Mastra-named successor of the LangGraph
 * SelectVisualizationNode). DI-resolved `@step` class.
 */
@step(STEP_SELECT_VISUALISATION)
export class SelectVisualisationStep implements IWorkflowStep<SelectIn> {
  constructor(
    @inject.tag(VISUALIZATION_KEY)
    private readonly visualizers: IVisualizer[] = [],
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
  ) {}

  async execute({
    inputData,
    requestContext,
    tracingContext,
  }: WorkflowStepCtx<SelectIn>) {
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

    const visualizers = this.visualizers;
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
        this.datasetStore,
        inputData.datasetId,
      );
    }

    const selection = await selectViaLlm(
      inputData.userQuery,
      visualizers,
      this.cheapModel ?? this.chatModel,
      tracingContext,
      data,
    );

    if ('rejected' in selection) {
      return {...base, chartType: '', rejected: true, reason: selection.reason};
    }
    return {...base, chartType: selection.chartType};
  }
}
