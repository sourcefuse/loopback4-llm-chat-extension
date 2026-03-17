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

@graphNode(DbQueryNodes.VerifyChecklist)
export class VerifyChecklistNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly smartLlm: LLMProvider,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks?: string[],
    @inject(AiIntegrationBindings.SmartNonThinkingLLM, {optional: true})
    private readonly smartNonThinkingLlm?: LLMProvider,
  ) {}

  private get llm(): LLMProvider {
    return this.smartNonThinkingLlm ?? this.smartLlm;
  }

  basePrompt = `
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

`;

  evaluationOutputInstructions = `<output-instructions>
First, evaluate each rule inside an evaluation tag. For each rule, repeat the full rule text exactly as given, followed by " — Include" or " — Exclude" with a brief reason.
Then, return only the comma-separated list of included rule indexes inside a result tag.

Example:
<evaluation>
1. When matching names, use ilike with wildcards — Include, query involves name matching
2. Format dates using to_char — Exclude, no date fields in this query
3. Always exclude lost deals — Include, query involves deals
</evaluation>
<result>1,3</result>

If no rules are relevant: <result>none</result>
</output-instructions>`;

  simpleOutputInstructions = `<output-instructions>
Return only a comma-separated list of the relevant rule indexes inside a result tag.
Do not include any other text, explanation, or formatting.
Example: 
<result>1,3,5</result>
If no rules are relevant:
<result>none</result>
</output-instructions>`;

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    // Skip on retry — checklist was already verified on the first pass
    if (state.feedbacks?.length) {
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
      data: 'Verifying validation checklist with chain-of-thought.',
    });

    const indexedChecks = allChecks
      .map((check, i) => `${i + 1}. ${check}`)
      .join('\n');

    const useEvaluation =
      this.config.nodes?.verifyChecklistNode?.evaluation ?? false;
    const promptTemplate = PromptTemplate.fromTemplate(
      this.basePrompt +
        (useEvaluation
          ? this.evaluationOutputInstructions
          : this.simpleOutputInstructions),
    );
    const chain = RunnableSequence.from([promptTemplate, this.llm]);
    const output = await chain.invoke({
      prompt: state.prompt,
      tables: Object.keys(state.schema?.tables ?? {}).join(', '),
      schema: this.schemaHelper.asString(state.schema),
      indexedChecks,
    });

    const response = stripThinkingTokens(output).trim();
    const resultMatch = response.match(/<result>(.*?)<\/result>/s);
    const indexStr = resultMatch ? resultMatch[1].trim() : response;

    if (indexStr === 'none' || !indexStr) {
      return {} as DbQueryState;
    }

    const verifiedIndexes = indexStr
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n >= 1 && n <= allChecks.length);

    if (verifiedIndexes.length === 0) {
      return {} as DbQueryState;
    }

    // Merge with existing checklist — union of both passes
    const existingChecks = new Set(
      (state.validationChecklist ?? '').split('\n').filter(c => c.length > 0),
    );
    const verifiedChecks = verifiedIndexes.map(i => allChecks[i - 1]);
    for (const check of verifiedChecks) {
      existingChecks.add(check);
    }

    const validationChecklist = Array.from(existingChecks).join('\n');

    return {validationChecklist} as DbQueryState;
  }
}
