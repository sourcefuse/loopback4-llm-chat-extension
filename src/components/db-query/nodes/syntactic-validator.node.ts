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
import {EvaluationResult, IDbConnector} from '../types';

@graphNode(DbQueryNodes.SyntacticValidator)
export class SyntacticValidatorNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
    @inject(DbQueryAIExtensionBindings.Connector)
    private readonly connector: IDbConnector,
  ) {}

  prompt =
    PromptTemplate.fromTemplate(`You are an AI assistant that categorizes the SQL query error and identifies related tables.

Here is the SQL query error that you need to categorize -
{error}

Here is the query that resulted in the error -
{query}

Here are all the available tables in the database -
{tableNames}

Categorize the error into one of these two categories:
- table_not_found: Any error that indicates a table or column is missing
- query_error: All other errors

Also identify ALL tables that are related to the error. Be generous - include tables that are directly involved in the error, tables referenced in the failing part of the query, and tables that might need to be joined or referenced to fix the error. It is better to include extra tables than to miss any.

Return your response in exactly this format with no other text:
<category>table_not_found or query_error</category>
<tables>comma, separated, table, names</tables>
`);

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Validating generated SQL query',
      },
    });

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Validating the query syntactically.`,
    });

    try {
      if (!state.sql) {
        throw new Error('No SQL query generated to validate');
      }
      await this.connector.validate(state.sql);
      return {
        syntacticStatus: EvaluationResult.Pass,
      } as DbQueryState;
    } catch (error) {
      const tableNames = Object.keys(state.schema?.tables ?? {});
      const chain = RunnableSequence.from([this.prompt, this.llm]);
      const output = await chain.invoke({
        error: error.message,
        query: state.sql,
        tableNames: tableNames.join(', '),
      });
      const result = stripThinkingTokens(output);

      const categoryMatch = /<category>(.*?)<\/category>/s.exec(result);
      const tablesMatch = /<tables>(.*?)<\/tables>/s.exec(result);

      const category = categoryMatch
        ? (categoryMatch[1].trim() as EvaluationResult)
        : (result.trim() as EvaluationResult);
      const errorTables = tablesMatch
        ? tablesMatch[1]
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0)
        : [];

      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Query Validation Failed by DB: ${category} with error ${error.message}`,
      });
      return {
        syntacticStatus: category,
        syntacticFeedback: `Query Validation Failed by DB: ${category} with error ${error.message}`,
        syntacticErrorTables: errorTables,
      } as DbQueryState;
    }
  }
}
