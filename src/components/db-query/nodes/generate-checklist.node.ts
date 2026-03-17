import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbSchemaHelperService} from '../services';
import {DbQueryState} from '../state';
import {DbQueryConfig} from '../types';

@graphNode(DbQueryNodes.GenerateChecklist)
export class GenerateChecklistNode implements IGraphNode<DbQueryState> {
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
You are given a user question, the tables selected for SQL generation, the relevant database schema, and a numbered list of rules/checks.
Return ONLY the indexes of the rules that are relevant to the user's question, the selected tables, and the given schema.

A rule is relevant if:
- It directly affects how a correct SQL query should be written for this question.
- It is a dependency of another relevant rule (e.g. if rule 3 requires a currency conversion, and rule 5 defines how currency conversion works, both must be included).
- It applies to any of the selected tables or their relationships.

After selecting relevant rules, review your selection and ensure:
- Any rule that is referenced by, or is a prerequisite for, another selected rule is also included.
- Do not include rules that are completely unrelated to the question, schema, or selected tables.
</instructions>

<user-question>
{prompt}
</user-question>

<selected-tables>
{tables}
</selected-tables>

<database-schema>
{schema}
</database-schema>

<rules>
{indexedChecks}
</rules>

<output-instructions>
Return only a comma-separated list of the relevant rule indexes.
Do not include any other text, explanation, or formatting.
Example: 1,3,5
If no rules are relevant, return: none
</output-instructions>`);

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    // Skip if checklist was already generated (e.g. retry paths)
    if (state.validationChecklist) {
      return {} as DbQueryState;
    }

    // Skip for small schemas (1-2 tables) — context is already small enough
    const tableCount = Object.keys(state.schema?.tables ?? {}).length;
    if (tableCount <= 2) {
      return {} as DbQueryState;
    }

    const allChecks = [
      ...(this.checks ?? []),
      ...this.schemaHelper.getTablesContext(state.schema),
    ];

    if (allChecks.length === 0) {
      return {} as DbQueryState;
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: 'Filtering validation checklist for semantic validation.',
    });

    const indexedChecks = allChecks
      .map((check, i) => `${i + 1}. ${check}`)
      .join('\n');

    const parallelism =
      this.config.nodes?.generateChecklistNode?.parallelism ?? 1;

    const chain = RunnableSequence.from([this.prompt, this.llm]);
    const invokeArgs = {
      prompt: state.prompt,
      tables: Object.keys(state.schema?.tables ?? {}).join(', '),
      schema: this.schemaHelper.asString(state.schema),
      indexedChecks,
    };

    // Run N parallel calls and union the results
    const results = await Promise.all(
      Array.from({length: parallelism}, () => chain.invoke(invokeArgs)),
    );

    const mergedIndexes = this.parseCheckIndexes(results, allChecks.length);

    if (mergedIndexes.size === 0) {
      return {} as DbQueryState;
    }

    const validationChecklist = Array.from(mergedIndexes)
      .sort((a, b) => a - b)
      .map(i => allChecks[i - 1])
      .join('\n');

    return {validationChecklist} as DbQueryState;

  private parseCheckIndexes(
    results: string[],
    totalChecks: number,
  ): Set<number> {
    const mergedIndexes = new Set<number>();
    for (const output of results) {
      const response = stripThinkingTokens(output).trim();
      if (!response) continue;
      const indexStr = response;
      if (indexStr === 'none') continue;
      indexStr
        .split(',')
        .map(s => Number.parseInt(s.trim(), 10))
        .filter(n => !Number.isNaN(n) && n >= 1 && n <= totalChecks)
        .forEach(n => mergedIndexes.add(n));
    }
    return mergedIndexes;
  }
  }
}
