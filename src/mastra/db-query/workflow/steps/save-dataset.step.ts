import {generateText} from 'ai';
import {HttpErrors} from '@loopback/rest';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {createHash} from 'crypto';
import {AnyObject} from '@loopback/repository';
import {DbSchemaHelperService} from '../../../../components/db-query/services';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  DatabaseSchema,
  DbQueryConfig,
  IDataSetStore,
} from '../../../../components/db-query/types';
import {DEFAULT_MAX_READ_ROWS_FOR_AI} from '../../../../components/db-query/constant';
import {LLMStreamEventType, ToolStatus} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')('ai-integration:mastra:db-query:save-dataset');

const DESCRIPTION_FALLBACK_PROMPT = `You are an AI assitant that generates a short description of a query based on a given schema, providing a summary of the query's intent and user's demand in a way that is short but does not miss any importance detail.

  Here is the query that you need to describe - {query}

  And here is the schema that was used to generate the query -
  {schema}


  {checks}
  The output should be a valid description of the query that is easy to understand by the user in plain text, without any formatting`;

export type SaveDatasetStepDeps = {
  llm: LLMProvider;
  store: IDataSetStore;
  config: DbQueryConfig;
  user: IAuthUserWithPermissions;
  dbSchemaHelper: DbSchemaHelperService;
  checks?: string[];
};

/**
 * Persists the validated SQL query as a dataset record. If `state.description`
 * is already populated (by `generateDescriptionStep`), skips the fallback LLM
 * call. Emits a `ToolStatus.Completed` event so the frontend can render the
 * data grid.
 */
export async function saveDatasetStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: SaveDatasetStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {sql: state.sql, hasDescription: !!state.description});

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: 'Dataset generated',
  });

  const tenantId = deps.user.tenantId;
  if (!tenantId) {
    throw new HttpErrors.BadRequest('User does not have a tenantId');
  }
  if (!state.sql) {
    throw new HttpErrors.InternalServerError();
  }

  let description = state.description;

  if (!description) {
    debug('generating fallback description via LLM');
    const content = buildPrompt(DESCRIPTION_FALLBACK_PROMPT, {
      query: state.sql,
      schema: deps.dbSchemaHelper.asString(state.schema),
      checks: [
        'You must keep these additional details in consideration while describing the query -',
        ...(deps.checks ?? []),
      ].join('\n'),
    });

    const {text, usage} = await generateText({
      model: deps.llm,
      messages: [{role: 'user', content}],
    });
    context.onUsage?.(
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      'unknown',
    );
    debug('token usage captured', {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
    });
    description = stripThinkingFromText(text);
  }

  const dataset = await deps.store.create({
    query: state.sql,
    tenantId,
    description,
    prompt: state.prompt,
    tables: getTableList(state.schema),
    schemaHash: hashSchema(state.schema),
    votes: 0,
  });

  if (!state.directCall) {
    context.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: ToolStatus.Completed,
        data: {datasetId: dataset.id},
      },
    });
  }

  let result: undefined | AnyObject[] = undefined;
  if (deps.config.readAccessForAI && dataset.id) {
    result = await deps.store.getData(
      dataset.id,
      deps.config.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI,
    );
  }

  const stepResult = {
    datasetId: dataset.id,
    replyToUser: description,
    done: true,
    resultArray: result,
  };
  debug('step result', {datasetId: dataset.id});
  return stepResult;
}

function hashSchema(schema: DatabaseSchema): string {
  const hash = createHash('sha256');
  const tableList = getTableList(schema).sort((a, b) => a.localeCompare(b));
  tableList.forEach(table => {
    hash.update(table);
    const columns = schema.tables[table]?.columns || {};
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
