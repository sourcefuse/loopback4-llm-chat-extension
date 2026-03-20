import {PromptTemplate} from '@langchain/core/prompts';
import {BaseRetriever} from '@langchain/core/retrievers';
import {RunnableSequence} from '@langchain/core/runnables';
import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbQueryState} from '../state';
import {QueryTemplateMetadata} from '../types';
import {PermissionHelper} from '../services/permission-helper.service';
import {SchemaStore} from '../services/schema.store';
import {TemplateHelper} from '../services/template-helper.service';

@graphNode(DbQueryNodes.CheckTemplates)
export class CheckTemplatesNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(DbQueryAIExtensionBindings.TemplateCache)
    private readonly templateCache: BaseRetriever<QueryTemplateMetadata>,
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
    @service(PermissionHelper)
    private readonly permissionHelper: PermissionHelper,
    @service(TemplateHelper)
    private readonly templateHelper: TemplateHelper,
    @service(SchemaStore)
    private readonly schemaStore: SchemaStore,
  ) {}

  matchPrompt = PromptTemplate.fromTemplate(`
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
</output-format>`);

  async execute(
    state: DbQueryState,
    config: RunnableConfig,
  ): Promise<Partial<DbQueryState>> {
    const relevantDocs = await this.templateCache.invoke(state.prompt, config);
    if (relevantDocs.length === 0) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: 'No templates found for this prompt',
      });
      return {};
    }

    const chain = RunnableSequence.from([
      this.matchPrompt,
      this.llm,
      stripThinkingTokens,
    ]);

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

    const response = await chain.invoke(
      {
        prompt: state.prompt,
        templates: templatesText,
      },
      config,
    );

    const trimmed = response.trim();
    if (trimmed === 'no_match') {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: 'No matching template found for this prompt',
      });
      return {};
    }

    const matchResult = trimmed.match(/^match\s+(\d+)$/);
    if (!matchResult) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Unexpected template match response: ${trimmed}`,
      });
      return {};
    }

    const matchIndex = parseInt(matchResult[1], 10) - 1;
    if (matchIndex < 0 || matchIndex >= relevantDocs.length) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Template match index ${matchResult[1]} out of bounds`,
      });
      return {};
    }

    const matchedDoc = relevantDocs[matchIndex];
    const template = this.templateHelper.parseTemplateMetadata(
      matchedDoc.metadata,
    );

    // Permission check
    const missingPermissions = this.permissionHelper.findMissingPermissions(
      template.tables,
    );
    if (missingPermissions.length > 0) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Template matched but missing permissions: ${missingPermissions.join(', ')}`,
      });
      return {};
    }

    // Resolve placeholders with column context from schema
    try {
      const schema = this.schemaStore.filteredSchema(template.tables);
      const resolved = await this.templateHelper.resolveTemplate(
        template,
        state.prompt,
        config,
        schema,
      );

      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Template matched: ${template.description}`,
      });
      config.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {
          status: `Matched query template`,
        },
      });

      return {
        sql: resolved.sql,
        description: resolved.description,
        fromTemplate: true,
        templateId: template.id,
      };
    } catch (error) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Template resolution failed: ${(error as Error).message}`,
      });
      return {};
    }
  }
}
