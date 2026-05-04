import {injectable, BindingScope, inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {generateObject} from 'ai';
import {z} from 'zod';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {
  IMastraVisualizer,
  MastraVisualizationState,
} from '../types/visualization.types';

const debug = require('debug')('ai-integration:mastra:visualization:pie');

/**
 * Zod schema describing the pie chart configuration returned by the LLM.
 * Mirrors the schema used by the LangGraph `PieVisualizer`.
 */
const PIE_CONFIG_SCHEMA = z.object({
  labelColumn: z
    .string()
    .describe('Column to be used for labels in the pie chart'),
  valueColumn: z
    .string()
    .describe('Column to be used for values in the pie chart'),
});

/**
 * Mastra-path pie-chart visualizer.
 *
 * Replaces the LangGraph `PieVisualizer` by using AI SDK `generateObject()`
 * instead of `BaseChatModel.withStructuredOutput()`. Business logic and
 * prompt are identical — only the LLM call site changes.
 *
 * Implements `IMastraVisualizer` so `selectVisualizationStep` can discover
 * and rank it alongside other Mastra visualizers.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraPieVisualizerService implements IMastraVisualizer {
  /** Unique chart type key — must match the value returned by the LLM. */
  readonly name = 'pie';

  readonly description =
    'Renders the data in a pie chart format. Best for visualizing proportions and percentages among categories.';

  readonly context =
    'A pie chart requires data with at least two columns: one for the labels (categories) and one for the values (numerical data). Ensure that the values are non-negative and represent parts of a whole, as pie charts are used to visualize proportions and percentages among different categories.';

  constructor(
    @inject(AiIntegrationBindings.AiSdkCheapLLM)
    private readonly llm: LLMProvider,
  ) {}

  /**
   * Uses AI SDK `generateObject()` with `PIE_CONFIG_SCHEMA` to map the SQL
   * query's columns to pie-chart segments.
   *
   * @param state  Current visualization state with `sql`, `queryDescription`,
   *               and `prompt` already populated.
   * @returns      `{ labelColumn, valueColumn }` chart config.
   */
  async getConfig(
    state: MastraVisualizationState,
    onUsage?: (
      inputTokens: number,
      outputTokens: number,
      model: string,
    ) => void,
  ): Promise<AnyObject> {
    if (!state.sql || !state.queryDescription || !state.prompt) {
      throw new Error(
        'MastraPieVisualizerService: Invalid State — sql, queryDescription and prompt are required',
      );
    }

    debug(
      'Generating pie chart config for sql=%s',
      state.sql?.substring(0, 80),
    );

    const systemPrompt = `You are an expert data visualization assistant. Your task is to create a pie chart config based on the provided SQL query, its description and user prompt. Follow these steps:
1. Analyze the SQL query results to understand the data structure.
2. Identify the key categories and their corresponding values for the pie chart.
3. Create a configuration object for the pie chart using the identified categories and values.
4. Return the pie chart configuration object.`;

    const userPrompt = `<sql>
${state.sql}
</sql>
<description>
${state.queryDescription}
</description>
<user-prompt>
${state.prompt}
</user-prompt>`;

    // Cast to avoid TS2589 (deep overload inference in AI SDK v6)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (generateObject as any)({
      model: this.llm,
      schema: PIE_CONFIG_SCHEMA,
      system: systemPrompt,
      prompt: userPrompt,
    })) as {
      object: {labelColumn: string; valueColumn: string};
      usage: {inputTokens: number; outputTokens: number};
    };

    onUsage?.(
      result.usage.inputTokens ?? 0,
      result.usage.outputTokens ?? 0,
      'unknown',
    );
    debug('token usage captured', {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    });
    debug('Pie chart config generated: %o', result.object);
    return result.object as AnyObject;
  }
}
