import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {LlmService} from '../../../services/llm.service';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {getTextContent} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbSchemaHelperService} from '../services';
import {DbQueryState} from '../state';
import {DbQueryConfig} from '../types';

@graphNode(DbQueryNodes.GenerateDescription)
export class GenerateDescriptionNode implements IGraphNode<DbQueryState> {
  constructor(
    @service(LlmService)
    private readonly llmService: LlmService,
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks?: string[],
  ) {}

  prompt = `
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

  async execute(
    state: DbQueryState,
    config: RunnableConfig,
  ): Promise<DbQueryState> {
    const generateDesc =
      this.config.nodes?.sqlGenerationNode?.generateDescription !== false;

    if (!generateDesc || !state.sql) {
      return {} as DbQueryState;
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: 'Generating query description.',
    });

    const result = await this.llmService.invoke(
      this.llm,
      this.llmService.render(this.prompt, {
        prompt: state.prompt,
        sql: state.sql,
        schema: this.schemaHelper.asString(state.schema),
        checks: [
          '<must-follow-rules>',
          ...(this.checks ?? []),
          ...this.schemaHelper.getTablesContext(state.schema),
          '</must-follow-rules>',
        ].join('\n'),
      }),
      {config},
    );

    const output = getTextContent(result.content);
    if (output) {
      config.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {thinkingToken: output},
      });
    }

    // Strip thinking tokens from the accumulated string
    let description = output.replace(/<think(ing)?>.*?<\/think(ing)?>/gs, '');
    description = description.replace(/.*?<\/think(ing)?>/gs, '').trim();

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Query description: ${description}`,
    });

    return {description} as DbQueryState;
  }
}
