import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject} from '@loopback/context';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbQueryState} from '../state';
import {DbQueryConfig, EvaluationResult} from '../types';

@graphNode(DbQueryNodes.SemanticValidator)
export class SemanticValidatorNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly smartllm: LLMProvider,
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly cheapllm: LLMProvider,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
  ) {}

  prompt = PromptTemplate.fromTemplate(`
<instructions>
You are an AI assistant that validates whether a SQL query satisfies a given checklist.
The query has already been validated for syntax and correctness.
Go through each checklist item and verify it against the SQL query.
DO NOT make up issues that do not exist in the query.
</instructions>

<sql-query>
{query}
</sql-query>

<validation-checklist>
{checklist}
</validation-checklist>

{feedbacks}

<output-instructions>
If the query satisfies ALL checklist items, return ONLY a valid tag with no other text:
<example-valid>
<valid/>
</example-valid>

If any checklist item is NOT satisfied, return an invalid tag containing each failed item with a detailed explanation of what is wrong and how it should be fixed:
<example-invalid>
<invalid>
- Salary values are not converted to USD. The query should join the exchange_rates table using currency_id and multiply salary by the rate.
- Lost and hold deals are not excluded. Add a WHERE condition to filter out deals with status 0 and 2.
</invalid>
</example-invalid>
</output-instructions>
`);

  feedbackPrompt = PromptTemplate.fromTemplate(`
<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.

But was rejected by validator with the following errors -
{feedback}

Keep these feedbacks in mind while validating the new query.
</feedback-instructions>`);

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: `Verifying if the query fully satisfies the user's requirement`,
      },
    });
    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Validating the query semantically.`,
    });
    const useSmartLLM =
      this.config.nodes?.semanticValidatorNode?.useSmartLLM ?? false;
    const llm = useSmartLLM ? this.smartllm : this.cheapllm;
    const chain = RunnableSequence.from([this.prompt, llm]);
    const output = await chain.invoke({
      query: state.sql,
      checklist: state.validationChecklist ?? 'No checklist provided.',
      feedbacks: await this.getFeedbacks(state),
    });
    const response = stripThinkingTokens(output);

    const invalidMatch = response.match(/<invalid>(.*?)<\/invalid>/s);
    const isValid =
      response.includes('<valid/>') || response.includes('<valid />');

    if (isValid && !invalidMatch) {
      return {
        semanticStatus: EvaluationResult.Pass,
      } as DbQueryState;
    } else {
      const reason = invalidMatch ? invalidMatch[1].trim() : response.trim();
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Query Validation Failed by LLM: ${reason}`,
      });
      return {
        semanticStatus: EvaluationResult.QueryError,
        semanticFeedback: `Query Validation Failed by LLM: ${reason}`,
      } as DbQueryState;
    }
  }

  async getFeedbacks(state: DbQueryState) {
    if (state.feedbacks?.length) {
      const feedbacks = await this.feedbackPrompt.format({
        feedback: state.feedbacks.join('\n'),
      });
      return feedbacks;
    }
    return '';
  }
}
