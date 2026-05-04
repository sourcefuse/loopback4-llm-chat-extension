import {generateText} from 'ai';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {stripThinkingFromText} from '../../../db-query/utils/thinking.util';
import {
  IMastraVisualizer,
  MastraVisualizationContext,
  MastraVisualizationState,
} from '../../types/visualization.types';

const debug = require('debug')(
  'ai-integration:mastra:visualization:select-visualization',
);

const SELECT_VISUALIZATION_PROMPT = `
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

/** Dependencies injected by `MastraVisualizationWorkflow`. */
export type SelectVisualizationStepDeps = {
  /** Cheap LLM used for the visualizer-selection decision. */
  llm: LLMProvider;
  /**
   * All registered Mastra visualizer service instances.
   * The step ranks them textually and returns one.
   */
  visualizers: IMastraVisualizer[];
};

/**
 * Selects the most appropriate chart type for the user's data.
 *
 * Two code paths:
 * 1. **Explicit type** (`state.type`): short-circuit — skip the LLM call and
 *    resolve the named visualizer directly (mirrors LangGraph `SelectVisualizationNode`).
 * 2. **LLM selection**: invokes `generateText()` from the AI SDK with a
 *    formatted prompt that lists all registered visualizers.
 *
 * Returns `Partial<MastraVisualizationState>` with either:
 *  - `{ visualizer, visualizerName }` on success, OR
 *  - `{ error }` when no matching visualizer is found.
 *
 * Mirrors `SelectVisualizationNode.execute()` in the LangGraph path.
 * LangGraph coupling removed: `PromptTemplate` / `RunnableSequence` →
 * plain `generateText()` + string interpolation.
 */
export async function selectVisualizationStep(
  state: MastraVisualizationState,
  context: MastraVisualizationContext,
  deps: SelectVisualizationStepDeps,
): Promise<Partial<MastraVisualizationState>> {
  debug('step start type=%s', state.type ?? '(auto)');

  const {visualizers} = deps;

  // ── Fast-path: caller specified an exact visualizer type ─────────────────
  if (state.type) {
    const selected = visualizers.find(v => v.name === state.type);
    if (!selected) {
      const available = visualizers.map(v => v.name).join(', ');
      throw new Error(
        `selectVisualizationStep: No visualizer found with name "${state.type}". Available: ${available}`,
      );
    }
    debug('fast-path: using explicit type=%s', state.type);
    return {visualizer: selected, visualizerName: selected.name};
  }

  // ── LLM-selection path ───────────────────────────────────────────────────
  context.writer?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Selecting best visualization for the data'},
  });

  const vizList = visualizers
    .map(v => `- ${v.name}: ${v.description}`)
    .join('\n');

  const prompt = SELECT_VISUALIZATION_PROMPT.replace('{prompt}', state.prompt)
    .replace('{sql}', state.sql ?? '')
    .replace('{description}', state.queryDescription ?? '')
    .replace('{visualizations}', vizList);

  debug('Calling LLM for visualization selection');
  const {text: rawOutput, usage} = await generateText({
    model: deps.llm,
    prompt,
  });
  context.onUsage?.(usage.inputTokens ?? 0, usage.outputTokens ?? 0, 'unknown');
  debug('token usage captured', {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  });
  const output = stripThinkingFromText(rawOutput).trim();
  debug('LLM selection result: %s', output);

  // LLM returned "none: <reason>" — no suitable visualization
  if (output.startsWith('none')) {
    return {error: output.substring(4).trim()};
  }

  const selected = visualizers.find(v => v.name === output);
  if (!selected) {
    const available = visualizers.map(v => v.name).join(', ');
    throw new Error(
      `selectVisualizationStep: LLM returned unknown visualizer "${output}". Available: ${available}`,
    );
  }

  debug('Selected visualizer: %s', selected.name);
  return {visualizer: selected, visualizerName: selected.name};
}
