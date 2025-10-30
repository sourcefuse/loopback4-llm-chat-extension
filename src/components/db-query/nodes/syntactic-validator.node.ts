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
    PromptTemplate.fromTemplate(`You are an AI assistant that categorizes the SQL query error in one of following two categories -
  - table_not_found
  - query_error

  Here is the SQL query error that you need to categorize -
  {error}

  and here is the query that resulted in the error -
  {query}

  Any error that indicates a table or column is missing should be categorized as table_not_found, all other errors should be categorized as query_error.
  Return only one of these two options as a string, without any additional text or comments.
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
        ...state,
        status: EvaluationResult.Pass,
      };
    } catch (error) {
      const chain = RunnableSequence.from([this.prompt, this.llm]);
      const output = await chain.invoke({
        error: error.message,
        query: state.sql,
      });
      const result = stripThinkingTokens(output);
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Query Validation Failed by DB: ${result} with error ${error.message}`,
      });
      return {
        ...state,
        status: result.trim() as EvaluationResult,
        feedbacks: [
          ...(state.feedbacks ?? []),
          `Query Validation Failed by DB: ${result} with error ${error.message}`,
        ],
      };
    }
  }
}
