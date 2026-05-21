import {PromptTemplate} from '@langchain/core/prompts';
import {
  IVisualizer,
  VisualizationConfigInput,
  VisualizationConfigOptions,
} from '../types';
import {AiIntegrationBindings} from '../../../keys';
import {inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import z from 'zod';
import {visualizer} from '../decorators/visualizer.decorator';
import {invokeLlmObject} from '../../../mastra/workflows/db-query/llm-helpers';
import type {MastraLanguageModel} from '@mastra/core/agent';

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

  context?: string | undefined =
    `A bar chart requires data with at exactly two columns: one for the categories (x-axis) and one for the values (y-axis). Ensure that the category column contains discrete values representing different groups or categories, while the value column contains numerical data that can be compared across these categories. Bar charts can be oriented either vertically or horizontally depending on the data representation needs.`;

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
    @inject(AiIntegrationBindings.MastraCheapLLM)
    private readonly llm: MastraLanguageModel,
  ) {}

  async getConfig(
    input: VisualizationConfigInput,
    options?: VisualizationConfigOptions,
  ): Promise<AnyObject> {
    if (!input.sql || !input.queryDescription || !input.prompt) {
      throw new Error('Invalid State');
    }

    const prompt = await this.renderPrompt.format({
      sql: input.sql,
      description: input.queryDescription,
      userPrompt: input.prompt,
    });

    const settings = await invokeLlmObject<AnyObject>(
      this.llm,
      prompt,
      this.schema,
      {
        requestContext: options?.requestContext,
        functionId: 'visualization.bar.config',
      },
    );

    return settings;
  }
}
