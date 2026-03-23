import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {inject} from '@loopback/core';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {
  DatabaseSchema,
  QueryTemplate,
  QueryTemplateMetadata,
  TemplatePlaceholder,
} from '../types';
import {RunnableConfig} from '../../../graphs';

const MAX_TEMPLATE_RECURSION_DEPTH = 3;

type ResolvedTemplate = {
  sql: string;
  description: string;
};

export class TemplateHelper {
  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
  ) {}

  extractionPrompt = PromptTemplate.fromTemplate(`
<instructions>
You are an expert at extracting parameter values from natural language prompts.
Given a user prompt, a SQL template, and a list of placeholders with their descriptions and types, extract the value for each placeholder from the prompt.
For sql_expression placeholders, generate a valid SQL fragment that fits the position of the placeholder in the template.
</instructions>
<user-prompt>
{prompt}
</user-prompt>
<sql-template>
{template}
</sql-template>
<placeholders>
{placeholders}
</placeholders>
<output-format>
Return each extracted value as an XML tag where the tag name is the placeholder name.
If a placeholder value cannot be determined from the prompt, use the default value if provided, or leave the tag empty.

Rules per type:
- string: Return the raw value only, without any surrounding quotes. Example: <customer>Acme Corp</customer>
- number: Return the numeric value only. Example: <limit>10</limit>
- boolean: Return true or false. Example: <is_active>true</is_active>
- sql_expression: Return a complete, valid SQL fragment with proper SQL syntax including quotes where needed. Example: <date_filter>created_at > '2024-01-01'</date_filter>

Do not return any other text or explanation, just the XML tags.
</output-format>`);

  async extractPlaceholderValues(
    placeholders: TemplatePlaceholder[],
    prompt: string,
    sqlTemplate: string,
    config: RunnableConfig,
    schema?: DatabaseSchema,
  ): Promise<Record<string, string | null>> {
    const chain = RunnableSequence.from([
      this.extractionPrompt,
      this.llm,
      stripThinkingTokens,
    ]);

    const placeholderDescriptions = placeholders
      .map(p => {
        let desc = `- ${p.name} (type: ${p.type}): ${p.description}`;
        if (p.default) desc += ` [default: ${p.default}]`;
        const columnContext = this._getColumnContext(p, schema);
        if (columnContext) desc += `\n  ${columnContext}`;
        return desc;
      })
      .join('\n');

    const response = await chain.invoke(
      {
        prompt,
        template: sqlTemplate,
        placeholders: placeholderDescriptions,
      },
      config,
    );

    return this._parseXmlValues(response, placeholders);
  }

  private _getColumnContext(
    placeholder: TemplatePlaceholder,
    schema?: DatabaseSchema,
  ): string | null {
    if (!schema || !placeholder.table || !placeholder.column) {
      return null;
    }
    const tableSchema = schema.tables[placeholder.table];
    if (!tableSchema) {
      return null;
    }
    const columnSchema = tableSchema.columns[placeholder.column];
    if (!columnSchema) {
      return null;
    }
    const parts: string[] = [
      `Column "${placeholder.column}" in "${placeholder.table}" (${columnSchema.type})`,
    ];
    if (columnSchema.description) {
      parts.push(columnSchema.description);
    }
    if (columnSchema.metadata) {
      const metaStr = Object.entries(columnSchema.metadata)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      if (metaStr) parts.push(metaStr);
    }
    // Include table-level context entries relevant to this column
    parts.push(
      ...this._getRelevantContextEntries(
        tableSchema.context,
        placeholder.column,
      ),
    );
    return parts.join('. ');
  }

  private _getRelevantContextEntries(
    context: unknown[] | undefined,
    column: string,
  ): string[] {
    if (!context?.length) {
      return [];
    }
    const results: string[] = [];
    for (const ctx of context) {
      if (
        typeof ctx === 'string' &&
        ctx.toLowerCase().includes(column.toLowerCase())
      ) {
        results.push(ctx);
      } else if (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, string>)[column]
      ) {
        results.push((ctx as Record<string, string>)[column]);
      } else {
        // do nothing
      }
    }
    return results;
  }

  private _parseXmlValues(
    xml: string,
    placeholders: TemplatePlaceholder[],
  ): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (const p of placeholders) {
      const match = new RegExp(
        String.raw`<${p.name}>([\s\S]*?)</${p.name}>`,
      ).exec(xml);
      const value = match?.[1]?.trim();
      result[p.name] = value?.length ? value : null;
    }
    return result;
  }

  async resolveTemplate(
    template: QueryTemplate,
    prompt: string,
    config: RunnableConfig,
    schema?: DatabaseSchema,
    templateFetcher?: (id: string) => Promise<QueryTemplate | undefined>,
    depth = 0,
  ): Promise<ResolvedTemplate> {
    if (depth > MAX_TEMPLATE_RECURSION_DEPTH) {
      throw new Error(
        `Max template recursion depth exceeded (${MAX_TEMPLATE_RECURSION_DEPTH})`,
      );
    }

    // 1. Resolve template_ref placeholders first (before the LLM call)
    let sql = await this._resolveTemplateRefs(
      template,
      prompt,
      config,
      schema,
      templateFetcher,
      depth,
    );

    // 2. Extract values only for non-template_ref placeholders via LLM
    const extractablePlaceholders = template.placeholders.filter(
      p => p.type !== 'template_ref',
    );

    let values: Record<string, string | null> = {};
    if (extractablePlaceholders.length > 0) {
      values = await this.extractPlaceholderValues(
        extractablePlaceholders,
        prompt,
        sql,
        config,
        schema,
      );
    }

    // 3. Substitute extracted values directly into SQL
    sql = this._substitutePlaceholders(sql, extractablePlaceholders, values);

    return {
      sql,
      description: template.description,
    };
  }

  private async _resolveTemplateRefs(
    template: QueryTemplate,
    prompt: string,
    config: RunnableConfig,
    schema: DatabaseSchema | undefined,
    templateFetcher:
      | ((id: string) => Promise<QueryTemplate | undefined>)
      | undefined,
    depth: number,
  ): Promise<string> {
    let sql = template.template;
    const templateRefPlaceholders = template.placeholders.filter(
      p => p.type === 'template_ref',
    );
    for (const placeholder of templateRefPlaceholders) {
      const marker = `{{${placeholder.name}}}`;
      if (!sql.includes(marker)) {
        continue;
      }
      if (!templateFetcher || !placeholder.templateId) {
        throw new Error(
          `Cannot resolve template_ref placeholder "${placeholder.name}" - no template fetcher or templateId`,
        );
      }
      const refTemplate = await templateFetcher(placeholder.templateId);
      if (!refTemplate) {
        throw new Error(
          `Referenced template "${placeholder.templateId}" not found`,
        );
      }
      const resolved = await this.resolveTemplate(
        refTemplate,
        prompt,
        config,
        schema,
        templateFetcher,
        depth + 1,
      );
      sql = sql.replace(marker, `(${resolved.sql})`);
    }
    return sql;
  }

  private _substitutePlaceholders(
    sql: string,
    placeholders: TemplatePlaceholder[],
    values: Record<string, string | null>,
  ): string {
    for (const placeholder of placeholders) {
      const value = values[placeholder.name] ?? placeholder.default ?? null;
      const marker = `{{${placeholder.name}}}`;

      if (!sql.includes(marker)) {
        continue;
      }

      if (placeholder.optional && !value) {
        sql = sql.replace(
          new RegExp(String.raw`\s*${this._escapeRegex(marker)}\s*`),
          ' ',
        );
        continue;
      }

      sql = sql.replace(marker, this._formatValue(placeholder.type, value));
    }
    return sql;
  }

  private _formatValue(type: string, value: string | null): string {
    switch (type) {
      case 'string':
        return `'${(value ?? '').replace(/'/g, "''")}'`;
      case 'number':
        return `${Number(value) || 0}`;
      case 'boolean':
        return this._isTruthy(value) ? 'TRUE' : 'FALSE';
      case 'sql_expression':
        return value ?? '1=1';
      default:
        return value ?? '';
    }
  }

  private _isTruthy(value: string | null): boolean {
    const lower = value?.toLowerCase();
    return lower === 'true' || lower === 'yes' || value === '1';
  }

  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  }

  parseTemplateMetadata(metadata: QueryTemplateMetadata): QueryTemplate {
    return {
      id: metadata.templateId,
      tenantId: '',
      template: metadata.template,
      description: metadata.description,
      placeholders: JSON.parse(metadata.placeholders),
      tables: JSON.parse(metadata.tables),
      schemaHash: metadata.schemaHash,
      votes: metadata.votes,
      prompt: '',
    };
  }
}
