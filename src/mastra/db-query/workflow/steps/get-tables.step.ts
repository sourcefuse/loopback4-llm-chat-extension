import {generateText} from 'ai';
import {
  DbSchemaHelperService,
  PermissionHelper,
} from '../../../../components/db-query/services';
import {SchemaStore} from '../../../../components/db-query/services/schema.store';
import {TableSearchService} from '../../../../components/db-query/services/search/table-search.service';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  DatabaseSchema,
  DbQueryConfig,
  GenerationError,
} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')('ai-integration:mastra:db-query:get-tables');

const GET_TABLES_PROMPT = `
<instructions>
You are an AI assistant that extracts table names that are relevant to the users query that will be used to generate an SQL query later.
- Consider not just the user query but also the context and the table descriptions while selecting the tables.
- Carefully consider each and every table before including or excluding it.
- If doubtful about a table's relevance, include it anyway to give the SQL generation step more options to choose from.
- Assume that the table would have appropriate columns for relating them to any other table even if the description does not mention it.
- If you are not sure about the tables to select from the given schema, just return your doubt asking the user for more details or to rephrase the question in the following format -
failed attempt: reason for failure
</instructions>

<tables-with-description>
{tables}
</tables-with-description>

<user-question>
{query}
</user-question>

{checks}

{feedbacks}

<output-format>
The output should be just a comma separated list of table names with no other text, comments or formatting.
Ensure that table names are exact and match the names in the input including schema if given.
<example-output>
public.employees, public.departments
</example-output>
In case of failure, return the failure message in the format -
failed attempt: <reason for failure>
<example-failure>
failed attempt: reason for failure
</example-failure>
</output-format>`;

const FEEDBACK_PROMPT = `
<feedback-instructions>
We also need to consider the errors from last attempt at query generation.

In the last attempt, these were the last tables selected:
{lastTables}

But it was rejected with the following errors:
{feedback}

Use these if they are relevant to the table selection, otherwise ignore them, they would be considered again during the SQL generation step.
</feedback-instructions>
`;

export type GetTablesStepDeps = {
  llmCheap: LLMProvider;
  llmSmart: LLMProvider;
  config: DbQueryConfig;
  schemaHelper: DbSchemaHelperService;
  schemaStore: SchemaStore;
  tableSearchService: TableSearchService;
  checks?: string[];
  permissionHelper?: PermissionHelper;
};

/**
 * Selects relevant tables from the schema using a vector similarity pre-filter
 * followed by an LLM classification call. Handles the two-attempt retry loop
 * to validate that returned table names exist in the schema.
 */
export async function getTablesStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: GetTablesStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {prompt: state.prompt});

  const tableList = await deps.tableSearchService.getTables(state.prompt, 10);
  const accessibleTables = filterByPermissions(
    tableList,
    deps.permissionHelper,
  );

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Selecting from tables: ${accessibleTables}`,
  });

  const dbSchema = deps.schemaStore.filteredSchema(accessibleTables);
  const allTables = getTablesFromSchema(dbSchema);

  if (allTables.length === 0) {
    throw new Error(
      'No tables found in the provided database schema. Please ensure the schema is valid.',
    );
  }

  const useSmartLLM = deps.config.nodes?.getTablesNode?.useSmartLLM ?? false;
  const llm = useSmartLLM ? deps.llmSmart : deps.llmCheap;

  context.writer?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Extracting relevant tables from the schema'},
  });

  const feedbacksText = await buildFeedbacks(state, deps.schemaHelper);
  const content = buildPrompt(GET_TABLES_PROMPT, {
    tables: allTables.join('\n\n'),
    query: state.prompt,
    feedbacks: feedbacksText,
    checks: [
      '<must-follow-rules>',
      ...(deps.checks ?? []).map(check => `- ${check}`),
      ...deps.schemaHelper
        .getTablesContext(dbSchema)
        .map(check => `- ${check}`),
      '</must-follow-rules>',
    ].join('\n'),
  });

  let attempts = 0;
  let requiredTables: string[] = [];

  while (attempts < 2) {
    attempts++;
    debug('table selection attempt %d', attempts);

    const {text, usage} = await generateText({
      model: llm,
      messages: [{role: 'user', content}],
    });
    context.onUsage?.(
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      'unknown',
    );
    debug('token usage captured attempt=%d', attempts, {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
    });

    const output = stripThinkingFromText(text);

    if (output.startsWith('failed attempt:')) {
      context.writer?.({
        type: LLMStreamEventType.Log,
        data: `Table selection failed: ${output}`,
      });
      return {
        status: GenerationError.Failed,
        replyToUser: output.replace('failed attempt: ', ''),
      };
    }

    const lastLine = output.split('\n').pop() ?? '';
    requiredTables = lastLine.split(',').map(t => t.trim());

    if (validateTables(requiredTables, dbSchema)) {
      break;
    }

    if (attempts === 2) {
      return {
        status: GenerationError.Failed,
        replyToUser:
          'Not able to select relevant tables from the schema. Please rephrase the question or provide more details.',
      };
    }

    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `LLM returned invalid tables: ${lastLine}, trying again`,
    });
  }

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Picked tables - ${requiredTables.join(', ')}`,
  });

  if (requiredTables.length === 0) {
    throw new Error(
      'LLM did not return a valid comma separated string response.',
    );
  }

  const result = {schema: deps.schemaStore.filteredSchema(requiredTables)};
  debug('step result tables=%o', requiredTables);
  return result;
}

async function buildFeedbacks(
  state: DbQueryState,
  schemaHelper: DbSchemaHelperService,
): Promise<string> {
  if (!state.feedbacks) return '';
  return buildPrompt(FEEDBACK_PROMPT, {
    lastTables: tableListFromSchema(state.schema).join(', '),
    feedback: state.feedbacks.join('\n'),
  });
}

function tableListFromSchema(schema: DatabaseSchema): string[] {
  if (!schema?.tables) return [];
  return Object.keys(schema.tables);
}

function getTablesFromSchema(schema: DatabaseSchema): string[] {
  if (!schema?.tables) return [];
  return Object.keys(schema.tables).map(tableName => {
    const table = schema.tables[tableName];
    return `${tableName}: ${table.description}`;
  });
}

function filterByPermissions(
  tables: string[],
  permissionHelper?: PermissionHelper,
): string[] {
  if (!permissionHelper) return tables;
  return tables.filter(t => {
    const name = t.toLowerCase().slice(t.indexOf('.') + 1);
    return permissionHelper.findMissingPermissions([name]).length === 0;
  });
}

function validateTables(tables: string[], schema: DatabaseSchema): boolean {
  return tables.every(t => schema.tables[t] !== undefined);
}
