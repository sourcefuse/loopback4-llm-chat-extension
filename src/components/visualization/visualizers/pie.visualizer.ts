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
export class PieVisualizer implements IVisualizer {
  name = 'pie';
  description = `Renders the data in a pie chart format. Best for visualizing proportions and percentages among categories.`;
  renderPrompt = PromptTemplate.fromTemplate(`
<instructions>
You are an expert data visualization assistant. Your task is to create a pie chart config based on the provided SQL query, it's description and user prompt. Follow these steps:
1. Analyze the SQL query results to understand the data structure.
2. Identify the key categories and their corresponding values for the pie chart.
3. Create a configuration object for the pie chart using the identified categories and values.
4. Return the pie chart configuration object.
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
    `A pie chart requires data with at least two columns: one for the labels (categories) and one for the values (numerical data). Ensure that the values are non-negative and represent parts of a whole, as pie charts are used to visualize proportions and percentages among different categories.`;

  schema = z.object({
    labelColumn: z
      .string()
      .describe('Column to be used for labels in the pie chart'),
    valueColumn: z
      .string()
      .describe('Column to be used for values in the pie chart'),
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
        functionId: 'visualization.pie.config',
      },
    );

    return settings;
  }
}
