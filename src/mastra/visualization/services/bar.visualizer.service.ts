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

const debug = require('debug')('ai-integration:mastra:visualization:bar');

/**
 * Zod schema describing the bar chart configuration returned by the LLM.
 * Mirrors the schema used by the LangGraph `BarVisualizer`.
 */
const BAR_CONFIG_SCHEMA = z.object({
  categoryColumn: z
    .string()
    .describe('Column to be used for categories (x-axis) in the bar chart'),
  valueColumn: z
    .string()
    .describe('Column to be used for values (y-axis) in the bar chart'),
  orientation: z
    .string()
    .default('vertical')
    .describe(
      'Orientation of the bar chart: `vertical` or `horizontal` without backticks',
    ),
});

/**
 * Mastra-path bar-chart visualizer.
 *
 * Replaces the LangGraph `BarVisualizer` by using AI SDK `generateObject()`
 * instead of `BaseChatModel.withStructuredOutput()`. Business logic and
 * prompt are identical — only the LLM call site changes.
 *
 * Implements `IMastraVisualizer` so `selectVisualizationStep` can discover
 * and rank it alongside other Mastra visualizers.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraBarVisualizerService implements IMastraVisualizer {
  /** Unique chart type key — must match the value returned by the LLM. */
  readonly name = 'bar';

  readonly description =
    'Renders the data in a bar chart format. Best for comparing values across different categories or showing trends over time.';

  readonly context =
    'A bar chart requires data with at exactly two columns: one for the categories (x-axis) and one for the values (y-axis). Ensure that the category column contains discrete values representing different groups or categories, while the value column contains numerical data that can be compared across these categories. Bar charts can be oriented either vertically or horizontally depending on the data representation needs.';

  constructor(
    @inject(AiIntegrationBindings.AiSdkCheapLLM)
    private readonly llm: LLMProvider,
  ) {}

  /**
   * Uses AI SDK `generateObject()` with `BAR_CONFIG_SCHEMA` to map the SQL
   * query's columns to bar-chart axes.
   *
   * @param state  Current visualization state with `sql`, `queryDescription`,
   *               and `prompt` already populated.
   * @returns      `{ categoryColumn, valueColumn, orientation }` chart config.
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
        'MastraBarVisualizerService: Invalid State — sql, queryDescription and prompt are required',
      );
    }

    debug(
      'Generating bar chart config for sql=%s',
      state.sql?.substring(0, 80),
    );

    const systemPrompt = `You are an expert data visualization assistant. Your task is to create a bar chart config based on the provided SQL query, its description and user prompt. Follow these steps:
1. Analyze the SQL query results to understand the data structure.
2. Identify the category column (x-axis) and value column (y-axis) for the bar chart.
3. Create a configuration object for the bar chart using the identified columns.
4. Return the bar chart configuration object.`;

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
      schema: BAR_CONFIG_SCHEMA,
      system: systemPrompt,
      prompt: userPrompt,
    })) as {
      object: {
        categoryColumn: string;
        valueColumn: string;
        orientation: string;
      };
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
    debug('Bar chart config generated: %o', result.object);
    return result.object as AnyObject;
  }
}
