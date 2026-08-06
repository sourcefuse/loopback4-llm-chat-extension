import {generateObject} from 'ai';
import {IVisualizer} from '../types';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {VisualizationGraphState} from '../state';
import z from 'zod';
import {renderPrompt} from '../../../graphs';
import {visualizer} from '../decorators/visualizer.decorator';

@visualizer()
export class PieVisualizer implements IVisualizer {
  name = 'pie';
  description = `Renders the data in a pie chart format. Best for visualizing proportions and percentages among categories.`;
  renderPrompt = `
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
</inputs>`;

  context?: string | undefined =
    `A pie chart requires data with at least two columns: one for the labels (categories) and one for the values (numerical data). Ensure that the values are non-negative and represent parts of a whole, as pie charts are used to visualize proportions and percentages among different categories.`;

  schema = z.object({
    labelColumn: z
      .string()
      .describe('Column to be used for labels in the pie chart'),
    valueColumn: z
      .string()
      .describe('Column to be used for values in the pie chart'),
  }) as z.ZodType;

  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
  ) {}

  async getConfig(state: VisualizationGraphState): Promise<AnyObject> {
    if (!state.sql || !state.queryDescription || !state.prompt) {
      throw new Error('Invalid State');
    }
    const {object} = await generateObject({
      ...this.llm.defaultSettings,
      model: this.llm,
      schema: this.schema,
      prompt: renderPrompt(this.renderPrompt, {
        sql: state.sql!,
        description: state.queryDescription!,
        userPrompt: state.prompt!,
      }),
    });
    const settings = object as AnyObject;
    return settings;
  }
}
