import {generateText} from 'ai';
import {PermissionHelper} from '../../../../components/db-query/services';
import {DbQueryState} from '../../../../components/db-query/state';
import {Errors} from '../../../../components/db-query/types';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')(
  'ai-integration:mastra:db-query:check-permissions',
);

const PERMISSIONS_PROMPT = `You are an AI assistant that received the following request from the user -
  {prompt}

  But as this request requires access to the following tables -
  {tables}

  and user the does not have permissions for the following tables -
  {missingPermissions}

  You must return an error message that explains the user that they do not have permissions to access the required tables and cannot proceed with the request, and then asking him to give a new request.
  Do not give direct tables names or any technical details, use plain language to explain the error.
  Do not return any other text, comments, or explanations. Only return a simple error message with request for new prompt.
  `;

export type CheckPermissionsStepDeps = {
  llm: LLMProvider;
  permissions: PermissionHelper;
};

/**
 * Verifies the current user's RBAC permissions against the tables in the
 * resolved schema. If any permissions are missing, uses the LLM to compose
 * a plain-language error message and sets `state.status = Errors.PermissionError`.
 */
export async function checkPermissionsStep(
  state: DbQueryState,
  _context: MastraDbQueryContext,
  deps: CheckPermissionsStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {schema: Object.keys(state.schema?.tables ?? {})});

  const tableNames = getTableNames(state);
  const missingPermissions =
    deps.permissions.findMissingPermissions(tableNames);

  if (missingPermissions.length === 0) {
    debug('all permissions granted');
    return {};
  }

  debug('missing permissions for tables: %o', missingPermissions);

  const content = buildPrompt(PERMISSIONS_PROMPT, {
    prompt: state.prompt,
    tables: tableNames.join(', '),
    missingPermissions: missingPermissions.join(', '),
  });

  const {text, usage} = await generateText({
    model: deps.llm,
    messages: [{role: 'user', content}],
  });
  _context.onUsage?.(
    usage.inputTokens ?? 0,
    usage.outputTokens ?? 0,
    'unknown',
  );
  debug('token usage captured', {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  });

  const response = stripThinkingFromText(text);

  const result = {
    status: Errors.PermissionError,
    replyToUser: response,
  };
  debug('step result', result);
  return result;
}

function getTableNames(state: DbQueryState): string[] {
  return Object.keys(state.schema?.tables ?? {}).map(table =>
    table.toLowerCase().slice(table.indexOf('.') + 1),
  );
}
