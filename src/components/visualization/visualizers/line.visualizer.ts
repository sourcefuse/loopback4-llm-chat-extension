import {PromptTemplate} from '@langchain/core/prompts';
import {IVisualizer} from '../types';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {VisualizationGraphState} from '../state';
import z from 'zod';
import {RunnableSequence} from '@langchain/core/runnables';
import {visualizer} from '../decorators/visualizer.decorator';

@visualizer()
export class LineVisualizer implements IVisualizer {
  name = 'line';
  description = `Renders the data in a line chart format. Best for showing trends and changes over time or continuous data.`;
  renderPrompt = PromptTemplate.fromTemplate(`
<instructions>
You are an expert data visualization assistant. Your task is to create a line chart config based on the provided SQL query, it's description and user prompt. Follow these steps:
1. Analyze the SQL query results to understand the data structure.
2. Identify the x-axis column (typically time or sequential data) and y-axis column (values) for the line chart.
3. Determine if there are multiple series to be plotted (multiple lines).
4. Create a configuration object for the line chart using the identified columns.
5. Return the line chart configuration object.
</instructions>
<inputs>
<sql>
{sql}
</sql>
<description>
{description}
</description>
<user-prompt>
{userPrompt}
</user-prompt>
</inputs>`);

  schema = z.object({
    xAxisColumn: z
      .string()
      .describe(
        'Column to be used for x-axis in the line chart (typically time or sequential data)',
      ),
    yAxisColumn: z
      .string()
      .describe('Column to be used for y-axis values in the line chart'),
    seriesColumn: z
      .string()
      .describe(
        'Optional column to group data into multiple lines/series, leave it as empty string if not needed',
      ),
  }) as z.AnyZodObject;

  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
  ) {}

  async getConfig(state: VisualizationGraphState): Promise<AnyObject> {
    if (!state.sql || !state.queryDescription || !state.prompt) {
      throw new Error('Invalid State');
    }
    const llmWithStructuredOutput = this.llm.withStructuredOutput<AnyObject>(
      this.schema,
    );

    const chain = RunnableSequence.from([
      this.renderPrompt,
      llmWithStructuredOutput,
    ]);

    const settings = await chain.invoke({
      sql: state.sql!,
      description: state.queryDescription!,
      userPrompt: state.prompt!,
    });
    if (settings.seriesColumn === '' || settings.seriesColumn === undefined) {
      settings.seriesColumn = null;
    }
    return settings;
  }
}
