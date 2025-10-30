import {Context, inject} from '@loopback/context';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {VisualizationGraphState} from '../state';
import {VisualizationGraphNodes} from '../nodes.enum';
import {PromptTemplate} from '@langchain/core/prompts';
import {stripThinkingTokens} from '../../../utils';
import {RunnableSequence} from '@langchain/core/runnables';
import {VISUALIZATION_KEY} from '../keys';
import {IVisualizer} from '../types';
import {POST_DATASET_TAG} from '../../db-query';

@graphNode(VisualizationGraphNodes.SelectVisualisation, {
  [POST_DATASET_TAG]: true,
})
export class SelectVisualizationNode
  implements IGraphNode<VisualizationGraphState>
{
  prompt = PromptTemplate.fromTemplate(`
<instructions>
You are expert Data Analysis Agent whose job is to suggest visualisations that would be best suited to display the results for a particular user prompt and the data extracted based on that prompt.
You are provided with 3 inputs -
- user prompt
- sql query generated to fetch the data that satisfies that prompt
- desciption of that sql query explaining the logic behind it.
- A list of visualization names with their descriptions that are supported.

You need to suggest a visualisation from a list of visualisation that would best fit the data and user's request.
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
If the required visualization would not be possible due to the structure of the data, return "none" followed by the changes required in the data to be able to render the visualization.
Do not try to force fit the data to any visualization if it does not make sense. Prefer to returning none with appropriate reason instead.
</instructions>
<output-example-1>
type-of-visualization
</output-example-1>
<output-example-2>
none: reason why the visualization is not possible with the current data and what changes are required in the data to be able to render the visualization.
</output-example-2>
</output-format>
`);
  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
    @inject.context()
    private readonly context: Context,
  ) {}

  async execute(
    state: VisualizationGraphState,
    config: RunnableConfig,
  ): Promise<VisualizationGraphState> {
    const visualizations = await this._getVisualizations();
    if (state.type) {
      const selected = visualizations.find(v => v.name === state.type);
      if (!selected) {
        throw new Error(
          `No visualizer found with name ${state.type}, available visualizers are ${visualizations
            .map(v => v.name)
            .join(', ')}`,
        );
      }
      return {
        ...state,
        visualizer: selected,
        visualizerName: selected.name,
      };
    }
    const chain = RunnableSequence.from([
      this.prompt,
      this.llm,
      stripThinkingTokens,
    ]);
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Selecting best visualization for the data',
      },
    });
    const output = await chain.invoke({
      prompt: state.prompt,
      sql: state.sql,
      description: state.queryDescription,
      visualizations: visualizations
        .map(v => `- ${v.name}: ${v.description}`)
        .join('\n'),
    });
    if (output.trim().startsWith('none')) {
      return {
        ...state,
        error: output.trim().substring(4).trim(),
      };
    }
    const selected = visualizations.find(v => v.name === output.trim());
    if (!selected) {
      throw new Error(
        `No visualizer found with name ${output.trim()}, available visualizers are ${visualizations
          .map(v => v.name)
          .join(', ')}`,
      );
    }
    return {
      ...state,
      visualizer: selected,
      visualizerName: selected.name,
    };
  }

  private async _getVisualizations() {
    const bindings = this.context.findByTag({
      [VISUALIZATION_KEY]: true,
    });
    if (bindings.length === 0) {
      throw new Error(`Node with key ${VISUALIZATION_KEY} not found`);
    }
    return Promise.all(
      bindings.map(binding => this.context.get<IVisualizer>(binding.key)),
    );
  }
}
