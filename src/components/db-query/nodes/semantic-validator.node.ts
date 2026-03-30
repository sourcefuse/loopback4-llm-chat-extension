import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {
  DbSchemaHelperService,
  PermissionHelper,
  TableSearchService,
} from '../services';
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
    @service(TableSearchService)
    private readonly tableSearchService: TableSearchService,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
    @service(PermissionHelper)
    private readonly permissionHelper?: PermissionHelper,
  ) {}

  prompt = PromptTemplate.fromTemplate(`
<instructions>
You are an AI assistant that validates whether a SQL query satisfies a given checklist.
The query has already been validated for syntax and correctness.
Go through each checklist item and verify it against the SQL query.
DO NOT make up issues that do not exist in the query.
</instructions>

<user-question>
{userPrompt}
</user-question>

<sql-query>
{query}
</sql-query>

<database-schema>
{schema}
</database-schema>

<available-tables>
{tableNames}
</available-tables>

<validation-checklist>
{checklist}
</validation-checklist>

{feedbacks}

<output-instructions>
If the query satisfies ALL checklist items, return ONLY a valid tag with no other text:
<example-valid>
<valid/>
</example-valid>

If any checklist item is NOT satisfied, return your response in two sections:
1. An invalid tag containing each failed item with a detailed explanation of what is wrong and how it should be fixed.
2. A tables tag listing ALL table names from the available tables that are related to the errors. Be generous - include tables directly involved in the error, tables that need to be joined to fix the issue, and any tables that could be relevant. It is better to include extra tables than to miss any.

<example-invalid>
<invalid>
- Salary values are not converted to USD. The query should join the exchange_rates table using currency_id and multiply salary by the rate.
- Lost and hold deals are not excluded. Add a WHERE condition to filter out deals with status 0 and 2.
</invalid>
<tables>exchange_rates, deals, employees</tables>
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
    const tableList =
      (await this.tableSearchService.getTables(state.prompt)) ?? [];
    const accessibleTables = this._filterByPermissions(tableList);
    const chain = RunnableSequence.from([this.prompt, llm]);
    const output = await chain.invoke({
      userPrompt: state.prompt,
      query: state.sql,
      schema: this.schemaHelper.asString(state.schema),
      tableNames: accessibleTables.join(', '),
      checklist: state.validationChecklist ?? 'No checklist provided.',
      feedbacks: await this.getFeedbacks(state),
    });
    const response = stripThinkingTokens(output);

    const invalidMatch = /<invalid>(.*?)<\/invalid>/s.exec(response);
    const tablesMatch = /<tables>(.*?)<\/tables>/s.exec(response);
    const isValid =
      response.includes('<valid/>') || response.includes('<valid />');

    if (isValid && !invalidMatch) {
      return {
        semanticStatus: EvaluationResult.Pass,
      } as DbQueryState;
    } else {
      const reason = invalidMatch ? invalidMatch[1].trim() : response.trim();
      const errorTables = tablesMatch
        ? tablesMatch[1]
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0)
        : [];
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Query Validation Failed by LLM: ${reason}`,
      });
      return {
        semanticStatus: EvaluationResult.QueryError,
        semanticFeedback: `Query Validation Failed by LLM: ${reason}`,
        semanticErrorTables: errorTables,
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

  private _filterByPermissions(tables: string[]): string[] {
    const permHelper = this.permissionHelper;
    if (!permHelper) {
      return tables;
    }
    return tables.filter(t => {
      const name = t.toLowerCase().slice(t.indexOf('.') + 1);
      return permHelper.findMissingPermissions([name]).length === 0;
    });
  }
}
