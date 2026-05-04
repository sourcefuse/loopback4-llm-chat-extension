import {streamText} from 'ai';
import {DbSchemaHelperService} from '../../../../components/db-query/services';
import {DbQueryState} from '../../../../components/db-query/state';
import {DbQueryConfig} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')(
  'ai-integration:mastra:db-query:generate-description',
);

const DESCRIPTION_PROMPT = `
<instructions>
You are an AI assistant that describes what a SQL query does in plain english.
Analyze the actual query below and write a concise, bulleted summary of the data it retrieves and any filters/conditions it applies.
Write in plain english. No SQL, no technical jargon, no table/column names.
</instructions>

<user-question>
{prompt}
</user-question>

<sql-query>
{sql}
</sql-query>

<database-schema>
{schema}
</database-schema>

{checks}

<output-instructions>
Return a short bulleted list where each bullet is one condition, filter, or piece of data the query retrieves.
- Use plain, non-technical language a business user would understand.
- Do NOT mention tables, columns, joins, CTEs, enums, or any DB concepts.
- Keep each bullet to one line.
- Do not add any preamble, heading, or closing text — just the bullets.
</output-instructions>`;

export type GenerateDescriptionStepDeps = {
  llm: LLMProvider;
  config: DbQueryConfig;
  schemaHelper: DbSchemaHelperService;
  checks?: string[];
};

/**
 * Streams a plain-English description of the generated SQL query and forwards
 * each text chunk as a `ToolStatus` SSE event. Uses `streamText()` from the
 * Vercel AI SDK. Runs concurrently with the syntactic and semantic validators
 * in the workflow's `Promise.all()` fan-out.
 */
export async function generateDescriptionStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: GenerateDescriptionStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {sql: state.sql});

  const generateDesc =
    deps.config.nodes?.sqlGenerationNode?.generateDescription !== false;

  if (!generateDesc || !state.sql) {
    debug('description generation skipped');
    return {};
  }

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: 'Generating query description.',
  });

  const content = buildPrompt(DESCRIPTION_PROMPT, {
    prompt: state.prompt,
    sql: state.sql,
    schema: deps.schemaHelper.asString(state.schema),
    checks: [
      '<must-follow-rules>',
      ...(deps.checks ?? []),
      ...deps.schemaHelper.getTablesContext(state.schema),
      '</must-follow-rules>',
    ].join('\n'),
  });

  debug('streaming description');
  const result = streamText({
    model: deps.llm,
    messages: [{role: 'user', content}],
  });

  let accumulated = '';
  for await (const chunk of result.textStream) {
    if (chunk) {
      accumulated += chunk;
      context.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {thinkingToken: chunk},
      });
    }
  }

  const usage = await result.usage;
  context.onUsage?.(usage.inputTokens ?? 0, usage.outputTokens ?? 0, 'unknown');
  debug('token usage captured', {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  });

  const description = stripThinkingFromText(accumulated);

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Query description: ${description}`,
  });

  debug('step result description length=%d', description.length);
  return {description};
}
