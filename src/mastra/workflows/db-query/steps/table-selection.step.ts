import {createStep} from '@mastra/core/workflows';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';
import type {DatabaseSchema} from '../../../../components/db-query/types';

const TABLE_SELECTION_PROMPT = `
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

/**
 * TableSelectionStep — replaces GetTablesNode.
 *
 * Uses knowledge graph + vector search to find candidate tables,
 * then asks an LLM to pick the relevant ones.
 * Includes a 2-attempt internal retry loop.
 */
export const tableSelectionStep = createStep({
  id: 'table-selection',
  inputSchema: z.object({
    prompt: z.string(),
    feedbacks: z.array(z.string()).optional(),
    schema: DatabaseSchemaZ.optional(),
  }),
  outputSchema: z.object({
    schema: DatabaseSchemaZ.optional(),
    status: z.string().optional(),
    replyToUser: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const smartLlm = ctx.get('smartLlm');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const schemaStore = ctx.get('schemaStore');
    const schemaHelper = ctx.get('schemaHelper');
    const tableSearchService = ctx.get('tableSearchService');
    const permissionHelper = ctx.get('permissionHelper');
    const globalContext = ctx.get('globalContext');

    const tableList = await tableSearchService.getTables(inputData.prompt, 10);
    const accessibleTables = filterByPermissions(tableList, permissionHelper);

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Selecting from tables: ${accessibleTables}`,
    });

    const dbSchema = schemaStore.filteredSchema(accessibleTables);
    const allTables = getTablesFromSchema(dbSchema);
    if (allTables.length === 0) {
      throw new Error(
        'No tables found in the provided database schema. Please ensure the schema is valid.',
      );
    }

    const useSmartLLM =
      dbQueryConfig.nodes?.getTablesNode?.useSmartLLM ?? false;
    const llm = useSmartLLM ? smartLlm : cheapLlm;

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Extracting relevant tables from the schema'},
    });

    const feedbacksText = buildFeedbackText(
      inputData.feedbacks,
      inputData.schema,
    );

    const checks = [
      '<must-follow-rules>',
      ...(globalContext ?? []).map(check => `- ${check}`),
      ...schemaHelper.getTablesContext(dbSchema).map(check => `- ${check}`),
      '</must-follow-rules>',
    ].join('\n');

    const selectionResult = await selectTablesWithRetries({
      llm,
      prompt: inputData.prompt,
      allTables,
      feedbacksText,
      checks,
      dbSchema,
      writer,
      maxAttempts: 2,
    });

    if (selectionResult.status === 'failed') {
      return {
        status: 'failed',
        replyToUser: selectionResult.replyToUser,
      };
    }

    const requiredTables = selectionResult.tables;

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Picked tables - ${requiredTables.join(', ')}`,
    });

    if (requiredTables.length === 0) {
      throw new Error(
        'LLM did not return a valid comma separated string response.',
      );
    }

    return {
      schema: schemaStore.filteredSchema(requiredTables),
    };
  },
});

function getTablesFromSchema(schema: DatabaseSchema): string[] {
  return Object.keys(schema.tables).map(
    tableName => `${tableName}: ${schema.tables[tableName].description ?? ''}`,
  );
}

function filterByPermissions(
  tables: string[],
  permissionHelper:
    | {findMissingPermissions(tables: string[]): string[]}
    | undefined,
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

function buildFeedbackText(
  feedbacks: string[] | undefined,
  schema: z.infer<typeof DatabaseSchemaZ> | undefined,
): string {
  if (!feedbacks?.length) {
    return '';
  }

  const lastTables = schema ? Object.keys(schema.tables).join(', ') : '';
  return FEEDBACK_PROMPT.replace('{lastTables}', lastTables).replace(
    '{feedback}',
    feedbacks.join('\n'),
  );
}

function parseTableSelectionOutput(
  output: string,
): {status: 'failed'; reason: string} | {status: 'success'; tables: string[]} {
  if (output.startsWith('failed attempt:')) {
    return {
      status: 'failed',
      reason: output.replace('failed attempt: ', ''),
    };
  }

  const lastLine = output.split('\n').pop() ?? '';
  return {
    status: 'success',
    tables: lastLine.split(',').map(tableName => tableName.trim()),
  };
}

async function selectTablesWithRetries(params: {
  llm: MastraLanguageModel;
  prompt: string;
  allTables: string[];
  feedbacksText: string;
  checks: string;
  dbSchema: DatabaseSchema;
  writer: {
    write: (event: {
      type: LLMStreamEventType;
      data: string | {status: string};
    }) => Promise<void>;
  };
  maxAttempts: number;
}): Promise<
  | {status: 'failed'; replyToUser: string}
  | {status: 'success'; tables: string[]}
> {
  let attempts = 0;
  while (attempts < params.maxAttempts) {
    attempts++;
    const prompt = TABLE_SELECTION_PROMPT.replace(
      '{tables}',
      params.allTables.join('\n\n'),
    )
      .replace('{query}', params.prompt)
      .replace('{feedbacks}', params.feedbacksText)
      .replace('{checks}', params.checks);

    const rawResult = await invokeLlm(params.llm, prompt);
    const output = stripThinkingTokens(rawResult);
    const parsed = parseTableSelectionOutput(output);

    if (parsed.status === 'failed') {
      await params.writer.write({
        type: LLMStreamEventType.Log,
        data: `Table selection failed: ${output}`,
      });
      return {status: 'failed', replyToUser: parsed.reason};
    }

    if (validateTables(parsed.tables, params.dbSchema)) {
      return {status: 'success', tables: parsed.tables};
    }

    if (attempts === params.maxAttempts) {
      return {
        status: 'failed',
        replyToUser:
          'Not able to select relevant tables from the schema. Please rephrase the question or provide more details.',
      };
    }

    await params.writer.write({
      type: LLMStreamEventType.Log,
      data: `LLM returned invalid tables, trying again`,
    });
  }

  return {
    status: 'failed',
    replyToUser:
      'Not able to select relevant tables from the schema. Please rephrase the question or provide more details.',
  };
}
