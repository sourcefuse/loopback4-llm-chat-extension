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
import {
  ChangeType,
  DbQueryConfig,
  EvaluationResult,
  GenerationError,
} from '../types';

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
- Ensure proper grouping with brackets for where clauses with multiple conditions using AND and OR.
- Follow each and every single rule in the "must-follow-rules" section carefully while writing the query. DO NOT SKIP ANY RULE.
</instructions>
<user-question>
{question}
</user-question>
<context>
<database-schema>
{dbschema}
</database-schema>

{checks}

{exampleQueries}

{feedbacks}
</context>
<output-instructions>
{outputFormat}
</output-instructions>`);

  outputFormat = `
Output should only be a valid SQL query with no other special character or formatting.
Contains the required valid SQL satisfying all the constraints.
It should have no other character or symbol or character that is not part of SQLs.`;

  feedbackPrompt = PromptTemplate.fromTemplate(`
<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.
Make sure you fix the provided error without introducing any new or past errors.
In the last attempt, you generated this SQL query -
<last-generated-query>
{query}
</last-generated-query>

<last-error>
{feedback}
</last-error>

{historicalErrors}
</feedback-instructions>`);
  constructor(
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly sqlLLM: LLMProvider,
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly cheapllm: LLMProvider,
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
    let llm = this.sqlLLM;

    const isSingleTable =
      state.schema.tables && Object.keys(state.schema.tables).length === 1;

    // Use cheap LLM for validation fix retries — the query is close, just needs small corrections
    const isValidationFixRetry =
      state.feedbacks?.length &&
      state.feedbacks[state.feedbacks.length - 1].startsWith(
        'Query Validation Failed',
      );

    // Use changeType from ClassifyChangeNode to pick the right LLM
    if (
      state.changeType === ChangeType.Minor ||
      isSingleTable ||
      isValidationFixRetry
    ) {
      llm = this.cheapllm;
    } else  {
      llm = this.sqlLLM;
    }

    const chain = RunnableSequence.from([this.sqlGenerationPrompt, llm]);

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Generating SQL query from the prompt - ${state.prompt}`,
    });
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
      checks: this._buildChecks(state),
      feedbacks: await this.getFeedbacks(state),
      exampleQueries: state.feedbacks?.length
        ? ''
        : await this.sampleQueries(state),
      outputFormat: this.outputFormat,
    });
    const response = stripThinkingTokens(output);

    const sql =
      response
        .replace(/^```(?:sql)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim() || undefined;

    if (!sql) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `SQL generation failed: ${response}`,
      });
      return {
        status: GenerationError.Failed,
        replyToUser:
          'Failed to generate SQL query. Please try rephrasing your question or provide more details.',
      } as DbQueryState;
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Generated SQL query: ${sql}`,
    });

    return {
      status: EvaluationResult.Pass,
      sql,
    } as DbQueryState;
  }

  async getFeedbacks(state: DbQueryState) {
    if (state.feedbacks?.length) {
      const lastFeedback = state.feedbacks[state.feedbacks.length - 1];
      const otherFeedbacks = state.feedbacks.slice(0, -1);
      const feedbacks = await this.feedbackPrompt.format({
        query: state.sql,
        feedback: `This was the error in the latest query you generated - \n${lastFeedback}`,
        historicalErrors: otherFeedbacks.length
          ? [
              `<historical-feedbacks>`,
              `You already faced following issues in the past -`,
              otherFeedbacks.join('\n'),
              `</historical-feedbacks>`,
            ].join('\n')
          : '',
      });
      return feedbacks;
    }
    return '';
  }

  async sampleQueries(state: DbQueryState) {
    let startTag = `<similar-example-query>`;
    let endTag = `</similar-example-query>`;
    let baseLine = `Here is an example query for reference that is similar to the question asked and has been validated by the user`;
    if (!state.fromCache) {
      startTag = `<last-generated-query>`;
      endTag = `</last-generated-query>`;
      baseLine = `Here is the last valid SQL query that was generated for the user that is supposed to be used as the base line for the next query generation.`;
    }
    return state.sampleSql
      ? `${startTag}\n${baseLine} -
${state.sampleSql}
This was generated for the following question - \n${state.sampleSqlPrompt} \n\n
${endTag}`
      : '';
  }

  private _buildChecks(state: DbQueryState): string {
    // Use the filtered checklist from GenerateChecklist if available
    if (state.validationChecklist) {
      return [
        '<must-follow-rules>',
        'You must keep these additional details in mind while writing the query -',
        ...state.validationChecklist.split('\n').map(check => `- ${check}`),
        '</must-follow-rules>',
      ].join('\n');
    }
    // Fallback to full checks
    return [
      '<must-follow-rules>',
      'You must keep these additional details in mind while writing the query -',
      ...(this.checks ?? []).map(check => `- ${check}`),
      ...this.schemaHelper
        .getTablesContext(state.schema)
        .map(check => `- ${check}`),
      '</must-follow-rules>',
    ].join('\n');
  }
}
