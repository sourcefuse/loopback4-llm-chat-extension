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
export class BarVisualizer implements IVisualizer {
  name = 'bar';
  description = `Renders the data in a bar chart format. Best for comparing values across different categories or showing trends over time.`;
  renderPrompt = PromptTemplate.fromTemplate(`
<instructions>
You are an expert data visualization assistant. Your task is to create a bar chart config based on the provided SQL query, it's description and user prompt. Follow these steps:
1. Analyze the SQL query results to understand the data structure.
2. Identify the category column (x-axis) and value column (y-axis) for the bar chart.
3. Create a configuration object for the bar chart using the identified columns.
4. Return the bar chart configuration object.
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
    return settings;
  }
}
