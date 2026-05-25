import {IVisualizer, VisualizationGraphState} from '../types';
import {AiIntegrationBindings} from '../../../keys';
import {inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import z, {type ZodTypeAny} from 'zod';
import {generateObject} from 'ai';
import type {MastraModelConfig} from '@mastra/core/llm';
import {visualizer} from '../decorators/visualizer.decorator';

@visualizer()
export class BarVisualizer implements IVisualizer {
  name = 'bar';
  description = `Renders the data in a bar chart format. Best for comparing values across different categories or showing trends over time.`;

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

  protected readonly callGen = generateObject as (o: {
    model: unknown;
    schema: unknown;
    prompt: string;
  }) => Promise<{object: AnyObject}>;

  constructor(
    @inject(AiIntegrationBindings.MastraChatLLM)
    private readonly model: MastraModelConfig,
  ) {}

  async getConfig(state: VisualizationGraphState): Promise<AnyObject> {
    if (!state.sql || !state.queryDescription || !state.prompt) {
      throw new Error('Invalid State');
    }
    const prompt = `<instructions>
You are an expert data visualization assistant. Your task is to create a bar chart config based on the provided SQL query, it's description and user prompt. Follow these steps:
1. Analyze the SQL query results to understand the data structure.
2. Identify the category column (x-axis) and value column (y-axis) for the bar chart.
3. Create a configuration object for the bar chart using the identified columns.
4. Return the bar chart configuration object.
</instructions>
<inputs>
<sql>
${state.sql}
</sql>
<description>
${state.queryDescription}
</description>
<user-prompt>
${state.prompt}
</user-prompt>
</inputs>`;

    const schema: ZodTypeAny = this.schema;
    const {object} = await this.callGen({model: this.model, schema, prompt});
    return object;
  }
}
