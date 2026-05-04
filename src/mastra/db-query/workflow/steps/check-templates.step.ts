import {generateText} from 'ai';
import {PermissionHelper} from '../../../../components/db-query/services';
import {SchemaStore} from '../../../../components/db-query/services/schema.store';
import {DbQueryState} from '../../../../components/db-query/state';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {MastraTemplateHelperService} from '../../services/mastra-template-helper.service';
import {TemplateSearchService} from '../../services/template-search.service';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')(
  'ai-integration:mastra:db-query:check-templates',
);

const MATCH_PROMPT = `
<instructions>
You are an expert at matching user prompts to query templates.
Given a user prompt and a list of query templates with their canonical prompts and placeholders, determine if any template can EXACTLY fulfill the user's request.

A template is a match ONLY if ALL of the following are true:
- The template produces exactly the data the user is asking for — not more, not less
- The user's intent is identical to the template's purpose, just with different parameter values
- All non-optional placeholders can be filled from the user's prompt or have defaults
- The template does not include extra filters, columns, or logic that the user did not ask for
- The template does not omit any filters, columns, or logic that the user is asking for

Do NOT match if:
- The template is only similar or partially relevant
- The template would need structural changes beyond placeholder substitution to answer the question
- The user is asking for something the template cannot express through its placeholders alone
</instructions>
<user-prompt>
{prompt}
</user-prompt>
<templates>
{templates}
</templates>
<output-format>
If a template is an exact match, return: match <index-starting-from-1>
If no template exactly matches, return: no_match

Do not return any other text or explanation.
</output-format>`;

export type CheckTemplatesStepDeps = {
  templateSearch: TemplateSearchService;
  llm: LLMProvider;
  permissionHelper: PermissionHelper;
  templateHelper: MastraTemplateHelperService;
  schemaStore: SchemaStore;
};

/**
 * Performs a vector similarity search for matching SQL templates, then uses
 * the LLM to confirm an exact semantic match. If a match is found, resolves
 * all placeholders via `MastraTemplateHelperService`.
 */
export async function checkTemplatesStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: CheckTemplatesStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {prompt: state.prompt});

  const relevantDocs = await deps.templateSearch.search(state.prompt);

  if (relevantDocs.length === 0) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: 'No templates found for this prompt',
    });
    return {};
  }

  const templatesText = relevantDocs
    .map((doc, index) => {
      const metadata = doc.metadata;
      const placeholders = JSON.parse(metadata.placeholders);
      const placeholderText = placeholders
        .map(
          (p: {name: string; type: string; description: string}) =>
            `  - {{${p.name}}} (${p.type}): ${p.description}`,
        )
        .join('\n');
      return `<template-${index + 1}>
<prompt>${doc.pageContent}</prompt>
<placeholders>
${placeholderText}
</placeholders>
</template-${index + 1}>`;
    })
    .join('\n');

  const content = buildPrompt(MATCH_PROMPT, {
    prompt: state.prompt,
    templates: templatesText,
  });

  debug('invoking LLM for template matching');
  const {text, usage} = await generateText({
    model: deps.llm,
    messages: [{role: 'user', content}],
  });
  context.onUsage?.(usage.inputTokens ?? 0, usage.outputTokens ?? 0, 'unknown');
  debug('token usage captured', {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  });

  const trimmed = stripThinkingFromText(text).trim();

  if (trimmed === 'no_match') {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: 'No matching template found for this prompt',
    });
    return {};
  }

  const matchResult = trimmed.match(/^match\s+(\d+)$/);
  if (!matchResult) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `Unexpected template match response: ${trimmed}`,
    });
    return {};
  }

  const matchIndex = Number.parseInt(matchResult[1], 10) - 1;
  if (matchIndex < 0 || matchIndex >= relevantDocs.length) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `Template match index ${matchResult[1]} out of bounds`,
    });
    return {};
  }

  const matchedDoc = relevantDocs[matchIndex];
  const template = deps.templateHelper.parseTemplateMetadata(
    matchedDoc.metadata,
  );

  const missingPermissions = deps.permissionHelper.findMissingPermissions(
    template.tables,
  );
  if (missingPermissions.length > 0) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `Template matched but missing permissions: ${missingPermissions.join(', ')}`,
    });
    return {};
  }

  try {
    const schema = deps.schemaStore.filteredSchema(template.tables);
    // resolveTemplate expects a RunnableConfig-compatible object; MastraDbQueryContext
    // satisfies that structurally (writer + signal).
    const resolved = await deps.templateHelper.resolveTemplate(
      template,
      state.prompt,
      context as Parameters<typeof deps.templateHelper.resolveTemplate>[2],
      schema,
    );

    debug('template matched: %s', template.description);
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `Template matched: ${template.description}`,
    });
    context.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Matched query template'},
    });

    const result = {
      sql: resolved.sql,
      description: resolved.description,
      fromTemplate: true,
      templateId: template.id,
    };
    debug('step result', result);
    return result;
  } catch (error) {
    debug('error', error);
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `Template resolution failed: ${(error as Error).message}`,
    });
    return {};
  }
}
