import {injectable, BindingScope} from '@loopback/core';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import {tracedGenerateText} from '../steps/_helpers';
import type {DomainRuleContext} from '../steps/checklist.shared';
import type {DbSchemaHelperService} from './db-schema-helper.service';
import type {SchemaStore} from './schema.store';

const SELECTION_INSTRUCTIONS = `You are given a user question, the tables selected for SQL generation, the relevant database schema, and a numbered list of rules/checks.
Return ONLY the indexes of the rules that are relevant to the user's question, the selected tables, and the given schema.

A rule is relevant if:
- It directly affects how a correct SQL query should be written for this question.
- It is a dependency of another relevant rule (e.g. if rule 3 requires a currency conversion, and rule 5 defines how currency conversion works, both must be included).
- It applies to any of the selected tables or their relationships.

Ensure:
- Any rule that is referenced by, or is a prerequisite for, another selected rule is also included.
- Do not include rules that are completely unrelated to the question, schema, or selected tables.`;

const SIMPLE_OUTPUT = `<output-instructions>
Return ONLY the comma-separated list of relevant rule indexes inside a result tag.
Do NOT include any reasoning, analysis, or explanation — only the result tag.
Example:
<result>1,3,5</result>
If no rules are relevant:
<result>none</result>
</output-instructions>`;

const EVALUATION_OUTPUT = `<output-instructions>
First, evaluate each rule inside an evaluation tag. For each rule, repeat the full rule text exactly as given, followed by " — Include" or " — Exclude" with a brief reason.
Then, return only the comma-separated list of included rule indexes inside a result tag.
Example:
<evaluation>
1. When matching names, use ilike with wildcards — Include, query involves name matching
2. Format dates using to_char — Exclude, no date fields in this query
</evaluation>
<result>1</result>
If no rules are relevant: <result>none</result>
</output-instructions>`;

/**
 * The checklist domain-rule logic shared by generate-checklist and
 * verify-checklist, extracted into an injectable service so a consumer can
 * rebind it to override rule collection/filtering/merging.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class ChecklistHelper {
  /**
   * Filter the domain-rule candidate set down to the rules relevant to this
   * question. `parallelism` runs the cheap-tier selection N times and unions the
   * picks (v2 generate-checklist.node `runParallelChecklist`); `evaluation`
   * switches the smart-tier verify pass to chain-of-thought output. Returns the
   * selected rule strings (empty on no LLM, no rules, or any failure — the judge
   * is best-effort and must never fail the run).
   */
  async selectDomainRules(args: {
    globalContext: string[];
    schemaStore?: SchemaStore;
    schemaHelper?: DbSchemaHelperService;
    llm: LanguageModel | undefined;
    prompt: string;
    tables: string[];
    label: string;
    parallelism?: number;
    evaluation?: boolean;
    tracing?: TracingContext;
  }): Promise<string[]> {
    const {
      globalContext,
      schemaStore,
      schemaHelper,
      llm,
      prompt,
      tables,
      label,
      parallelism = 1,
      evaluation,
      tracing,
    } = args;
    if (!llm) return [];
    const {rules, schemaText} = this.collectDomainRules({
      globalContext,
      schemaStore,
      schemaHelper,
      tables,
    });
    if (rules.length === 0) return [];
    const filterPrompt = this.buildChecklistFilterPrompt({
      prompt,
      tables,
      schemaText,
      rules,
      evaluation,
    });
    const runs = Math.max(1, parallelism);
    try {
      const results = await Promise.all(
        Array.from({length: runs}, () =>
          tracedGenerateText({
            model: llm,
            prompt: filterPrompt,
            tracing,
            label,
            resultType: 'planning',
          }),
        ),
      );
      const merged = new Set<number>();
      for (const r of results) {
        for (const n of this.parseChecklistIndexes(r.text, rules.length)) {
          merged.add(n);
        }
      }
      return this.indexesToRules(merged, rules);
    } catch {
      return [];
    }
  }

  /**
   * Merge the explicit user-stated constraints (the mastra checklist) with the
   * selected domain rules into one newline-separated checklist, deduped. This is
   * the value fed to both SQL generation and semantic validation, so domain
   * rules are now ENFORCED at validation time (v2 parity), not only hinted to
   * the generator.
   */
  mergeChecklist(userChecklist: string, domainRules: string[]): string {
    const lines = new Set<string>();
    for (const line of userChecklist
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)) {
      lines.add(line);
    }
    for (const rule of domainRules) {
      const trimmed = rule.trim();
      if (trimmed) lines.add(trimmed);
    }
    return [...lines].join('\n');
  }

  private collectDomainRules(args: {
    globalContext: string[];
    schemaStore?: SchemaStore;
    schemaHelper?: DbSchemaHelperService;
    tables: string[];
  }): DomainRuleContext {
    const {globalContext, schemaStore, schemaHelper, tables} = args;
    let tableContext: string[] = [];
    let schemaText = '';
    if (schemaStore && schemaHelper) {
      try {
        const schema = schemaStore.filteredSchema(tables);
        tableContext = schemaHelper.getTablesContext(schema);
        schemaText = schemaHelper.asString(schema);
      } catch {
        // Schema not loaded / table missing — fall back to global rules only.
      }
    }
    // Dedupe, preserving order: global rules first, then per-table rules.
    const rules = [...new Set([...globalContext, ...tableContext])];
    return {rules, schemaText};
  }

  private indexChecks(rules: string[]): string {
    return rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  }

  private buildChecklistFilterPrompt(args: {
    prompt: string;
    tables: string[];
    schemaText: string;
    rules: string[];
    evaluation?: boolean;
  }): string {
    const base = `
<instructions>
${SELECTION_INSTRUCTIONS}
</instructions>

<user-question>
${args.prompt}
</user-question>

<selected-tables>
${args.tables.join(', ')}
</selected-tables>

<database-schema>
${args.schemaText}
</database-schema>

<rules>
${this.indexChecks(args.rules)}
</rules>
`;
    return base + (args.evaluation ? EVALUATION_OUTPUT : SIMPLE_OUTPUT);
  }

  /**
   * Parse rule indexes from a relevance reply. Reads the `<result>…</result>`
   * tag when present (verify pass / chain-of-thought) and otherwise treats the
   * whole reply as the comma list (lenient generate pass). `none` → no rules.
   */
  private parseChecklistIndexes(text: string, maxIndex: number): number[] {
    const trimmed = text.trim();
    const match = /<result>([\s\S]*?)<\/result>/.exec(trimmed);
    const indexStr = (match ? match[1] : trimmed).trim();
    if (!indexStr || /^none$/i.test(indexStr)) return [];
    return indexStr
      .split(',')
      .map(s => Number.parseInt(s.trim(), 10))
      .filter(n => !Number.isNaN(n) && n >= 1 && n <= maxIndex);
  }

  private indexesToRules(indexes: Iterable<number>, rules: string[]): string[] {
    return [...new Set(indexes)]
      .sort((a, b) => a - b)
      .map(i => rules[i - 1])
      .filter((r): r is string => Boolean(r));
  }
}
