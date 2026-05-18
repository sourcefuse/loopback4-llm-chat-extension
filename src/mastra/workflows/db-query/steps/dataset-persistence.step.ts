import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import type {AnyObject} from '@loopback/repository';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import type {DatabaseSchema} from '../../../../components/db-query/types';
import {createHash} from 'crypto';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

const rowObjectSchema = z.object({}).passthrough();

const DESCRIPTION_PROMPT = `You are an AI assitant that generates a short description of a query based on a given schema, providing a summary of the query's intent and user's demand in a way that is short but does not miss any importance detail.

  Here is the query that you need to describe - {query}

  And here is the schema that was used to generate the query -
  {schema}


  {checks}
  The output should be a valid description of the query that is easy to understand by the user in plain text, without any formatting`;

/**
 * DatasetPersistenceStep — replaces SaveDataSetNode.
 *
 * Saves the generated SQL as a dataset, optionally generates a description,
 * and returns the result to the user.
 */
export const datasetPersistenceStep = createStep({
  id: 'dataset-persistence',
  inputSchema: z.object({
    prompt: z.string(),
    sql: z.string(),
    schema: DatabaseSchemaZ,
    description: z.string().optional(),
    directCall: z.boolean().optional(),
  }),
  outputSchema: z.object({
    datasetId: z.string().optional(),
    replyToUser: z.string().optional(),
    done: z.boolean().optional(),
    resultArray: z.array(rowObjectSchema).optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const datasetStore = ctx.get('datasetStore');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const schemaHelper = ctx.get('schemaHelper');
    const globalContext = ctx.get('globalContext');
    const currentUser = ctx.get('currentUser');
    const schema = inputData.schema as DatabaseSchema;

    await writer.write({
      type: LLMStreamEventType.Log,
      data: 'Dataset generated',
    });

    const tenantId = currentUser.tenantId;
    if (!tenantId) {
      throw new Error('User does not have a tenantId');
    }

    let description = inputData.description;

    if (!description) {
      const checks = [
        'You must keep these additional details in consideration while describing the query -',
        ...(globalContext ?? []),
      ].join('\n');

      const prompt = DESCRIPTION_PROMPT.replace('{query}', inputData.sql)
        .replace('{schema}', schemaHelper.asString(schema))
        .replace('{checks}', checks);

      const rawOutput = await invokeLlm(cheapLlm, prompt);
      description = stripThinkingTokens(rawOutput);
    }

    const dataset = await datasetStore.create({
      query: inputData.sql,
      tenantId,
      description,
      prompt: inputData.prompt,
      tables: getTableList(schema),
      schemaHash: hashSchema(schema),
      votes: 0,
    });

    if (!inputData.directCall) {
      await writer.write({
        type: LLMStreamEventType.ToolStatus,
        data: {status: 'completed', data: {datasetId: dataset.id}},
      });
    }

    let resultArray: AnyObject[] | undefined;
    if (dbQueryConfig.readAccessForAI && dataset.id) {
      resultArray = await datasetStore.getData(
        dataset.id,
        dbQueryConfig.maxRowsForAI ?? 5,
      );
    }

    return {
      datasetId: dataset.id,
      replyToUser: description,
      done: true,
      resultArray,
    };
  },
});

function hashSchema(schema: DatabaseSchema): string {
  const hash = createHash('sha256');
  const tableList = getTableList(schema).sort((a, b) => a.localeCompare(b));
  tableList.forEach(table => {
    hash.update(table);
    const columns = schema.tables[table]?.columns ?? {};
    Object.keys(columns)
      .sort((a, b) => a.localeCompare(b))
      .forEach(column => {
        hash.update(`${column}:${columns[column].type}`);
      });
  });
  return hash.digest('hex');
}

function getTableList(schema: DatabaseSchema): string[] {
  if (!schema?.tables) return [];
  return Object.keys(schema.tables);
}
