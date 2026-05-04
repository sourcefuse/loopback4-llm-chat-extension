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

const debug = require('debug')('ai-integration:mastra:visualization:line');

/**
 * Zod schema describing the line chart configuration returned by the LLM.
 * Mirrors the schema used by the LangGraph `LineVisualizer`.
 */
const LINE_CONFIG_SCHEMA = z.object({
  xAxisColumn: z
    .string()
    .describe(
      'Single column name to be used for x-axis in the line chart (typically time or sequential data)',
    ),
  yAxisColumn: z
    .string()
    .describe(
      'Single column name to be used for y-axis values in the line chart',
    ),
  seriesColumns: z
    .string()
    .describe(
      'Optional column to group data into multiple lines/series, leave it as empty string if not needed. It can cover multiple columns separated by comma if the query needs to show multiple lines based on multiple columns. The UI supports multiple series in line chart by forming a combined key.',
    ),
});

/**
 * Mastra-path line-chart visualizer.
 *
 * Replaces the LangGraph `LineVisualizer` by using AI SDK `generateObject()`
 * instead of `BaseChatModel.withStructuredOutput()`. Business logic, prompt,
 * and post-processing of `seriesColumns` are identical — only the LLM call
 * site changes.
 *
 * Implements `IMastraVisualizer` so `selectVisualizationStep` can discover
 * and rank it alongside other Mastra visualizers.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraLineVisualizerService implements IMastraVisualizer {
  /** Unique chart type key — must match the value returned by the LLM. */
  readonly name = 'line';

  readonly description =
    'Renders the data in a line chart format. Best for showing trends and changes over time or continuous data.';

  readonly context =
    'A line chart requires data with exactly 3 columns: one for the x-axis (typically time or sequential data), one for the y-axis (values), and one series type column to distinguish multiple lines/series in the chart. The series type column is important for grouping data into separate lines.';

  constructor(
    @inject(AiIntegrationBindings.AiSdkSmartNonThinkingLLM)
    private readonly llm: LLMProvider,
  ) {}

  /**
   * Uses AI SDK `generateObject()` with `LINE_CONFIG_SCHEMA` to map the SQL
   * query's columns to line-chart axes.
   *
   * Post-processes `seriesColumns`:
   *  - Empty string / null / undefined → `null` (no series grouping)
   *  - Comma-separated string → `string[]` (multiple series)
   *
   * @param state  Current visualization state with `sql`, `queryDescription`,
   *               and `prompt` already populated.
   * @returns      `{ xAxisColumn, yAxisColumn, seriesColumns }` chart config.
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
        'MastraLineVisualizerService: Invalid State — sql, queryDescription and prompt are required',
      );
    }

    debug(
      'Generating line chart config for sql=%s',
      state.sql?.substring(0, 80),
    );

    const systemPrompt = `You are an expert data visualization assistant. Your task is to create a line chart config based on the provided SQL query, its description and user prompt. Follow these steps:
1. Analyze the SQL query results to understand the data structure.
2. Identify the x-axis column (typically time or sequential data) and y-axis column (values) for the line chart.
3. Determine if there are multiple series to be plotted (multiple lines) with combination of multiple columns, or single series based on single column.
4. Create a configuration object for the line chart using the identified columns.
5. Return the line chart configuration object.`;

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
      schema: LINE_CONFIG_SCHEMA,
      system: systemPrompt,
      prompt: userPrompt,
    })) as {
      object: {xAxisColumn: string; yAxisColumn: string; seriesColumns: string};
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

    // Normalise seriesColumns: empty string → null, CSV string → string[]
    const settings: AnyObject = {...result.object};
    if (
      settings.seriesColumns === '' ||
      settings.seriesColumns === undefined ||
      settings.seriesColumns === null
    ) {
      settings.seriesColumns = null;
    } else {
      settings.seriesColumns =
        (settings.seriesColumns as string)
          .split(',')
          .map((s: string) => s.trim()) ?? [];
    }

    debug('Line chart config generated: %o', settings);
    return settings;
  }
}
