import {IVisualizer, VisualizationGraphState} from '../types';
import {AiIntegrationBindings} from '../../../keys';
import {inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import z, {type ZodTypeAny} from 'zod';
import {generateObject} from 'ai';
import type {MastraModelConfig} from '@mastra/core/llm';
import {
  buildProviderOptions,
  resolveEnvTemperature,
} from '../../../mastra/workflows/db-query/_helpers';
import {visualizer} from '../decorators/visualizer.decorator';

@visualizer()
export class PieVisualizer implements IVisualizer {
  name = 'pie';
  description = `Renders the data in a pie chart format. Best for visualizing proportions and percentages among categories.`;

  context?: string | undefined =
    `A pie chart requires data with at least two columns: one for the labels (categories) and one for the values (numerical data). Ensure that the values are non-negative and represent parts of a whole, as pie charts are used to visualize proportions and percentages among different categories.`;

  schema = z.object({
    labelColumn: z
      .string()
      .describe('Column to be used for labels in the pie chart'),
    valueColumn: z
      .string()
      .describe('Column to be used for values in the pie chart'),
  }) as z.AnyZodObject;

  protected readonly callGen = generateObject as (o: {
    model: unknown;
    schema: unknown;
    prompt: string;
    providerOptions?: Record<string, Record<string, unknown>>;
    temperature?: number;
  }) => Promise<{object: AnyObject}>;

  constructor(
    @inject(AiIntegrationBindings.ChatLLM)
    private readonly model: MastraModelConfig,
  ) {}

  async getConfig(state: VisualizationGraphState): Promise<AnyObject> {
    if (!state.sql || !state.queryDescription || !state.prompt) {
      throw new Error('Invalid State');
    }
    const prompt = `<instructions>
You are an expert data visualization assistant. Your task is to create a pie chart config based on the provided SQL query, it's description and user prompt. Follow these steps:
1. Analyze the SQL query results to understand the data structure.
2. Identify the key categories and their corresponding values for the pie chart.
3. Create a configuration object for the pie chart using the identified categories and values.
4. Return the pie chart configuration object.
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
    const providerOptions = buildProviderOptions();
    const temperature = resolveEnvTemperature();
    const {object} = await this.callGen({
      model: this.model,
      schema,
      prompt,
      ...(temperature !== undefined ? {temperature} : {}),
      ...(providerOptions ? {providerOptions} : {}),
    });
    return object;
  }
}
