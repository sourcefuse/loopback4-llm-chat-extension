import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';

const TEMPLATE_MATCH_PROMPT = `
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

/**
 * TemplateMatchStep — replaces CheckTemplatesNode.
 *
 * Searches the template cache for matching query templates.
 * If a template matches exactly, resolves placeholders and returns the SQL.
 */
export const templateMatchStep = createStep({
  id: 'template-match',
  inputSchema: z.object({
    prompt: z.string(),
  }),
  outputSchema: z.object({
    sql: z.string().optional(),
    description: z.string().optional(),
    fromTemplate: z.boolean().optional(),
    templateId: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const templateCache = ctx.get('templateCache');
    const cheapLlm = ctx.get('cheapLlm');
    const permissionHelper = ctx.get('permissionHelper');
    const templateHelper = ctx.get('templateHelper');
    const schemaStore = ctx.get('schemaStore');

    const relevantDocs = await templateCache.invoke(inputData.prompt);
    if (relevantDocs.length === 0) {
      await writer.write({
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

    const prompt = TEMPLATE_MATCH_PROMPT.replace(
      '{prompt}',
      inputData.prompt,
    ).replace('{templates}', templatesText);

    const rawResponse = await invokeLlm(cheapLlm, prompt);
    const trimmed = stripThinkingTokens(rawResponse).trim();

    if (trimmed === 'no_match') {
      await writer.write({
        type: LLMStreamEventType.Log,
        data: 'No matching template found for this prompt',
      });
      return {};
    }

    const matchResult = trimmed.match(/^match\s+(\d+)$/);
    if (!matchResult) {
      await writer.write({
        type: LLMStreamEventType.Log,
        data: `Unexpected template match response: ${trimmed}`,
      });
      return {};
    }

    const matchIndex = Number.parseInt(matchResult[1], 10) - 1;
    if (matchIndex < 0 || matchIndex >= relevantDocs.length) {
      await writer.write({
        type: LLMStreamEventType.Log,
        data: `Template match index ${matchResult[1]} out of bounds`,
      });
      return {};
    }

    const matchedDoc = relevantDocs[matchIndex];
    const template = templateHelper.parseTemplateMetadata(matchedDoc.metadata);

    // Permission check
    if (permissionHelper) {
      const missingPermissions = permissionHelper.findMissingPermissions(
        template.tables,
      );
      if (missingPermissions.length > 0) {
        await writer.write({
          type: LLMStreamEventType.Log,
          data: `Template matched but missing permissions: ${missingPermissions.join(', ')}`,
        });
        return {};
      }
    }

    // Resolve placeholders with column context from schema
    try {
      const schema = schemaStore.filteredSchema(template.tables);
      const resolved = await templateHelper.resolveTemplate(
        template,
        inputData.prompt,
        {configurable: {}},
        schema,
      );

      await writer.write({
        type: LLMStreamEventType.Log,
        data: `Template matched: ${template.description}`,
      });
      await writer.write({
        type: LLMStreamEventType.ToolStatus,
        data: {status: 'Matched query template'},
      });

      return {
        sql: resolved.sql,
        description: resolved.description,
        fromTemplate: true,
        templateId: template.id,
      };
    } catch (error) {
      await writer.write({
        type: LLMStreamEventType.Log,
        data: `Template resolution failed: ${(error as Error).message}`,
      });
      return {};
    }
  },
});
