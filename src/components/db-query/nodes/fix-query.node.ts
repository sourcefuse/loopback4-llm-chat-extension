import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {RuntimeLLMProvider, SupportedDBs} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbSchemaHelperService} from '../services';
import {DbQueryState} from '../state';
import {
  DatabaseSchema,
  DbQueryConfig,
  EvaluationResult,
  GenerationError,
} from '../types';

@graphNode(DbQueryNodes.FixQuery)
export class FixQueryNode implements IGraphNode<DbQueryState> {
  fixPrompt = PromptTemplate.fromTemplate(`
<instructions>
You are an expert AI assistant that fixes SQL query errors.
You are given a SQL query that has validation errors related to specific tables.
Your task is to fix ONLY the parts of the query related to the listed error tables.
DO NOT change any part of the query that does not involve the error tables.
Preserve the overall structure, logic, and all other table references exactly as they are.

Rules:
- Only modify clauses, joins, columns, or conditions that involve the error tables.
- Do not add, remove, or reorder columns or tables that are not related to the error.
- Do not change aliases, formatting, or logic for unrelated parts of the query.
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Use the provided schema for the error-related tables to write correct SQL.
- The dialect is {dialect}.
</instructions>

<user-question>
{question}
</user-question>

<current-query>
{currentQuery}
</current-query>

<error-tables-schema>
{errorSchema}
</error-tables-schema>

<error-details>
{errorFeedback}
</error-details>

{checks}

{historicalErrors}

<output-instructions>
Output should only be a valid SQL query with no other special character or formatting.
Contains the required valid SQL with the error fixed.
It should have no other character or symbol or character that is not part of SQLs.
</output-instructions>`);

  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: RuntimeLLMProvider,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
  ) {}

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Fixing SQL query based on validation errors',
      },
    });
    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Fixing SQL query based on validation errors`,
    });

    const errorTables = [
      ...(state.syntacticErrorTables ?? []),
      ...(state.semanticErrorTables ?? []),
    ];

    const trimmedSchema = this.trimSchema(state.schema, errorTables);
    const errorSchemaString = this.schemaHelper.asString(trimmedSchema);

    const feedbacks = state.feedbacks ?? [];
    const lastFeedback = feedbacks[feedbacks.length - 1] ?? '';
    const historicalErrors = feedbacks.slice(0, -1);

    const chain = RunnableSequence.from([this.fixPrompt, this.llm]);
    const output = await chain.invoke({
      dialect: this.config.db?.dialect ?? SupportedDBs.PostgreSQL,
      question: state.prompt,
      currentQuery: state.sql ?? '',
      errorSchema: errorSchemaString,
      errorFeedback: lastFeedback,
      checks: this.buildChecks(state, trimmedSchema),
      historicalErrors: historicalErrors.length
        ? [
            `<historical-errors>`,
            `You already faced following issues in the past -`,
            historicalErrors.join('\n'),
            `</historical-errors>`,
          ].join('\n')
        : '',
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
        data: `SQL fix failed: ${response}`,
      });
      return {
        status: GenerationError.Failed,
        replyToUser:
          'Failed to fix SQL query. Please try rephrasing your question or provide more details.',
      } as DbQueryState;
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Fixed SQL query: ${sql}`,
    });

    return {
      status: EvaluationResult.Pass,
      sql,
    } as DbQueryState;
  }

  private trimSchema(
    fullSchema: DatabaseSchema,
    errorTables: string[],
  ): DatabaseSchema {
    const errorTableSet = new Set(errorTables);
    const trimmedTables: DatabaseSchema['tables'] = {};

    for (const tableName of Object.keys(fullSchema.tables)) {
      if (errorTableSet.has(tableName)) {
        trimmedTables[tableName] = fullSchema.tables[tableName];
      }
    }

    const trimmedRelations = fullSchema.relations.filter(
      rel =>
        errorTableSet.has(rel.table) || errorTableSet.has(rel.referencedTable),
    );

    return {
      tables: trimmedTables,
      relations: trimmedRelations,
    };
  }

  private buildChecks(
    state: DbQueryState,
    trimmedSchema: DatabaseSchema,
  ): string {
    if (state.validationChecklist) {
      return [
        '<must-follow-rules>',
        'You must keep these additional details in mind while fixing the query -',
        ...state.validationChecklist.split('\n').map(check => `- ${check}`),
        '</must-follow-rules>',
      ].join('\n');
    }
    const context = this.schemaHelper.getTablesContext(trimmedSchema);
    if (context.length === 0) return '';
    return [
      '<must-follow-rules>',
      'You must keep these additional details in mind while fixing the query -',
      ...context.map(check => `- ${check}`),
      '</must-follow-rules>',
    ].join('\n');
  }
}
