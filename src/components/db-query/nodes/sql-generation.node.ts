import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider, SupportedDBs} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbSchemaHelperService} from '../services';
import {DbQueryState} from '../state';
import {DbQueryConfig, EvaluationResult} from '../types';

@graphNode(DbQueryNodes.SqlGeneration)
export class SqlGenerationNode implements IGraphNode<DbQueryState> {
  sqlGenerationPrompt = PromptTemplate.fromTemplate(`
<instructions>
You are an expert AI assistant that generates SQL queries based on user questions and a given database schema.
You try to following the instructions carefully to generate the SQL query that answers the question.
Do not hallucinate details or make up information.
Your task is to convert a question into a SQL query, given a {dialect} database schema.
Adhere to these rules:
- **Deliberately go through the question and database schema word by word** to appropriately answer the question
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Never query for all the columns from a specific table, only ask for the relevant columns for the given the question.
- You can only generate a single query, so if you need multiple results you can use JOINs, subqueries, CTEs or UNIONS.
- Do not make any assumptions about the user's intent beyond what is explicitly provided in the prompt.
<instructions>


<context>
<user-question>
{question}
</user-question>

<database-schema>
{dbschema}
</database-schema>

{checks}

{exampleQueries}

{feedbacks}
<output-instructions>
Return the SQL query as a string, without any additional text, quotations, code block, comments or any other non sql token.
The output should be a valid SQL query that can run on the database schema provided.
</output-instructions>
</context>`);

  feedbackPrompt = PromptTemplate.fromTemplate(`
<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.
Make sure you do not repeat the mistakes made in the last attempt.
In the last attempt, you generated this SQL query -
<last-generated-query>
{query}
</last-generated-query>

<last-feedback>
{feedback}
</last-feedback>

<past-feedbacks>
{pastFeedbacks}
</past-feedbacks>

Keep these feedbacks in mind while generating the new query or improving this one SQL query.
</feedback-instructions>`);
  constructor(
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly sqlLLM: LLMProvider,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks?: string[],
  ) {}
  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    const chain = RunnableSequence.from([
      this.sqlGenerationPrompt,
      this.sqlLLM,
    ]);

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Generating SQL query from the prompt',
      },
    });

    const output = await chain.invoke({
      dialect: this.config.db?.dialect ?? SupportedDBs.PostgreSQL,
      question: state.prompt,
      dbschema: this.schemaHelper.asString(state.schema),
      checks: [
        '<must-follow-rules>',
        'You must keep these additional details in mind while writing the query -',
        ...(this.checks ?? []).map(check => `- ${check}`),
        ...this.schemaHelper
          .getTablesContext(state.schema)
          .map(check => `- ${check}`),
        '</must-follow-rules>',
      ].join('\n'),
      feedbacks: await this.getFeedbacks(state),
      exampleQueries: state.feedbacks?.length
        ? ''
        : await this.sampleQueries(state),
    });
    const response = stripThinkingTokens(output);

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Generated SQL query: ${response}`,
    });

    return {
      ...state,
      status: EvaluationResult.Pass,
      sql: response,
    };
  }

  async getFeedbacks(state: DbQueryState) {
    if (state.feedbacks?.length) {
      const lastFeedback = state.feedbacks[state.feedbacks.length - 1];
      const otherFeedbacks = state.feedbacks.slice(0, -1);
      const feedbacks = await this.feedbackPrompt.format({
        query: state.sql,
        feedback: `This was the error in the latest query you generated - \n${lastFeedback}`,
        pastFeedbacks: otherFeedbacks.length
          ? [
              `You already faced following issues in the past -`,
              otherFeedbacks.join('\n'),
            ].join('\n')
          : '',
      });
      return feedbacks;
    }
    return '';
  }

  async sampleQueries(state: DbQueryState) {
    let baseLine = `Here is an example query for reference that is similar to the question asked and has been validated by the user`;
    if (!state.fromCache) {
      baseLine = `Here is the last running SQL query that was generated by user that is supposed to be used as the base line for the next query generation.`;
    }
    return state.sampleSql
      ? `${baseLine} -
${state.sampleSql}
This was generated for the following question - \n${state.sampleSqlPrompt} \n\n
`
      : '';
  }
}
