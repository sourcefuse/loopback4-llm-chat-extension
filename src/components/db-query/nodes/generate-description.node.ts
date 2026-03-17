import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbSchemaHelperService} from '../services';
import {DbQueryState} from '../state';
import {DbQueryConfig} from '../types';

@graphNode(DbQueryNodes.GenerateDescription)
export class GenerateDescriptionNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks?: string[],
  ) {}

  prompt = PromptTemplate.fromTemplate(`
<instructions>
You are an AI assistant that summarizes what data a query would fetch to answer the user's question.
Write a concise, bulleted summary in plain english. No SQL, no technical jargon, no table/column names.
</instructions>

<user-question>
{prompt}
</user-question>

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
</output-instructions>`);

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    const generateDesc =
      this.config.nodes?.sqlGenerationNode?.generateDescription !== false;

    if (!generateDesc || state.description) {
      return {} as DbQueryState;
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: 'Generating query description.',
    });

    const chain = RunnableSequence.from([this.prompt, this.llm]);
    const stream = await chain.stream({
      prompt: state.prompt,
      schema: this.schemaHelper.asString(state.schema),
      checks: [
        '<must-follow-rules>',
        ...(this.checks ?? []),
        ...this.schemaHelper.getTablesContext(state.schema),
        '</must-follow-rules>',
      ].join('\n'),
    });

    let output = '';
    for await (const chunk of stream) {
      const token =
        typeof chunk === 'string' ? chunk : (chunk?.content ?? '').toString();
      if (token) {
        output += token;
        config.writer?.({
          type: LLMStreamEventType.ToolStatus,
          data: {thinkingToken: token},
        });
      }
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
