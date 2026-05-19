import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {VISUALIZATION_KEY} from '../../../../components/visualization/keys';
import {invokeLlm, stripThinkingTokens} from '../../db-query/llm-helpers';
import {asVisualizationContext} from '../visualization-request-context';
import {visualizationWorkflowStateSchema} from '../visualization-workflow-schemas';

const VISUALIZATION_SELECTION_PROMPT = `
<instructions>
You are expert Data Analysis Agent whose job is to suggest visualisations that would be best suited to display the results for a particular user prompt and the data extracted based on that prompt.
You are provided with 2 inputs -
- user prompt
- A list of visualization names with their descriptions that are supported.

You need to suggest a visualisation from a list of visualisation that would best fit the user's request.
</instructions>
<inputs>
<user-prompt>
{prompt}
</user-prompt>
<generated-query>
<sql>
{sql}
</sql>
<description>
{description}
</description>
</generated-query>
<visualization-list>
{visualizations}
</visualization-list>
</inputs>
<output-format>
<instructions>
The output should be a single string that has the name from the visualizations list and nothing else.
If none of the visualizations fit the requirement, return "none" followed by the changes required in the data to be able to render the visualization.
Do not try to force fit the prompt to any visualization if it does not make sense. Prefer to returning none with appropriate reason instead.
</instructions>
<output-example-1>
type-of-visualization
</output-example-1>
<output-example-2>
none: reason why the visualization is not possible with the current prompt.
</output-example-2>
</output-format>
`;

function buildSelectionPrompt(inputData: {
  prompt: string;
  sql?: string;
  queryDescription?: string;
  visualizations: string;
}): string {
  return VISUALIZATION_SELECTION_PROMPT.replace('{prompt}', inputData.prompt)
    .replace('{sql}', inputData.sql ?? '')
    .replace('{description}', inputData.queryDescription ?? '')
    .replace('{visualizations}', inputData.visualizations);
}

function buildUnknownVisualizerError(
  name: string,
  availableVisualizers: string[],
): string {
  return `No visualizer found with name ${name}, available visualizers are ${availableVisualizers.join(', ')}`;
}

export const visualizationSelectionStep = createStep({
  id: 'visualization-selection',
  inputSchema: z.object({
    prompt: z.string(),
    datasetId: z.string().optional(),
    type: z.string().optional(),
    sql: z.string().optional(),
    queryDescription: z.string().optional(),
    error: z.string().optional(),
  }),
  outputSchema: visualizationWorkflowStateSchema,
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asVisualizationContext(requestContext!);
    const visualizerStore = ctx.get('visualizerStore');
    const visualizations = visualizerStore.list;

    if (!visualizations.length) {
      throw new Error(`Node with key ${VISUALIZATION_KEY} not found`);
    }

    if (inputData.type) {
      const selected = visualizerStore.map[inputData.type];
      if (!selected) {
        throw new Error(
          buildUnknownVisualizerError(
            inputData.type,
            visualizations.map(v => v.name),
          ),
        );
      }

      return {
        ...inputData,
        visualizerName: selected.name,
        visualizerContext: selected.context,
      };
    }

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Selecting best visualization for the data',
      },
    });

    const selectionPrompt = buildSelectionPrompt({
      prompt: inputData.prompt,
      sql: inputData.sql,
      queryDescription: inputData.queryDescription,
      visualizations: visualizations
        .map(v => `- ${v.name}: ${v.description}`)
        .join('\n'),
    });

    const rawOutput = await invokeLlm(ctx.get('cheapLlm'), selectionPrompt);
    const output = stripThinkingTokens(rawOutput);

    if (output.trim().startsWith('none')) {
      return {
        ...inputData,
        error: output.trim().substring(4).trim(),
      };
    }

    const selected = visualizerStore.map[output.trim()];
    if (!selected) {
      throw new Error(
        buildUnknownVisualizerError(
          output.trim(),
          visualizations.map(v => v.name),
        ),
      );
    }

    return {
      ...inputData,
      visualizerName: selected.name,
      visualizerContext: selected.context,
    };
  },
});
