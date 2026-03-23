import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryNodes} from '../nodes.enum';
import {DbQueryState} from '../state';
import {ChangeType} from '../types';

@graphNode(DbQueryNodes.ClassifyChange)
export class ClassifyChangeNode implements IGraphNode<DbQueryState> {
  prompt = PromptTemplate.fromTemplate(`
<instructions>
You are given the original description of a SQL query and a new description that includes user feedback.
Your task is to classify the level of change required to transform the original query into the new one.

Classify as one of:
- **minor**: Small tweaks such as changing a filter value, adjusting a limit, adding/removing a single condition, or renaming an alias.
- **major**: Structural changes like adding/removing joins, changing grouping logic, adding subqueries, or significantly altering the WHERE clause.
- **rewrite**: The intent of the query has fundamentally changed, requiring a completely new query from scratch.
</instructions>

<original-description>
{originalDescription}
</original-description>

<new-description>
{newDescription}
</new-description>

<output-instructions>
Return ONLY one of: minor, major, rewrite
Do not include any other text, explanation, or formatting.
</output-instructions>`);

  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
  ) {}

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    if (!state.sampleSql) {
      return {} as DbQueryState;
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: 'Classifying the level of change required for the query.',
    });

    const chain = RunnableSequence.from([this.prompt, this.llm]);
    const output = await chain.invoke({
      originalDescription: state.sampleSqlPrompt ?? '',
      newDescription: state.prompt,
    });

    const response = stripThinkingTokens(output).trim().toLowerCase();
    const changeType = this.parseChangeType(response);

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Change classified as: ${changeType}`,
    });

    return {changeType} as DbQueryState;
  }

  private parseChangeType(response: string): ChangeType {
    if (response.includes(ChangeType.Minor)) return ChangeType.Minor;
    if (response.includes(ChangeType.Rewrite)) return ChangeType.Rewrite;
    return ChangeType.Major;
  }
}
