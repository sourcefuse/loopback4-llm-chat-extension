import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {PermissionHelper} from '../services';
import type {
  IQueryTemplateStore,
  TemplateCache,
  TemplateDoc,
  TemplateMatchOut,
} from '../types';
import {
  emitToolStatus,
  logStepDetail,
  tracedGenerateText,
  type Rc,
} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';

/**
 * Query-template gate (the successor of the LangGraph CheckTemplatesNode). A
 * DI-resolved `@graphNode` class with constructor-injected collaborators
 * (template cache, template store, permission helper, cheap LLM tier).
 *
 * The judge/authorise/resolve logic lives on the class as `protected` methods so
 * a host can `extends CheckTemplatesNode` and override the ACL rule or the match
 * resolution, then rebind under `@graphNode(DbQueryNodes.CheckTemplates)`.
 */
@graphNode(DbQueryNodes.CheckTemplates)
export class CheckTemplatesNode implements IGraphNode<
  {prompt?: string},
  TemplateMatchOut
> {
  constructor(
    @inject(DbQueryAIExtensionBindings.TemplateCache, {optional: true})
    protected readonly templateCache?: TemplateCache,
    @inject(DbQueryAIExtensionBindings.TemplateStore, {optional: true})
    protected readonly templateStore?: IQueryTemplateStore,
    @inject('services.PermissionHelper', {optional: true})
    protected readonly permissionHelper?: PermissionHelper,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
  ) {}

  async execute({
    inputData,
    requestContext,
    tracingContext,
  }: GraphNodeCtx<{prompt?: string}>): Promise<TemplateMatchOut> {
    const data = inputData;
    if (!data.prompt) return {matched: false};

    const cache = this.templateCache;
    const chatLlm = this.cheapModel ?? this.chatModel;
    if (!cache || !chatLlm) return {matched: false};

    let docs: Array<{pageContent: string; metadata: {id?: string}}> = [];
    try {
      docs = await cache.invoke(data.prompt);
    } catch {
      return {matched: false};
    }

    if (docs.length === 0) return {matched: false};

    const judgePrompt = this.buildJudgePrompt(data.prompt, docs);

    try {
      const verdict = await tracedGenerateText({
        model: chatLlm,
        prompt: judgePrompt,
        tracing: tracingContext,
        label: 'template-judge',
        resultType: 'reasoning',
      });
      const resolved = await this.resolveMatchedTemplate(
        requestContext,
        verdict.text.trim(),
        docs,
      );
      if (resolved) return resolved;
    } catch {
      // degrade to no match on judge failure
    }

    return {matched: false};
  }

  protected buildJudgePrompt(prompt: string, docs: TemplateDoc[]): string {
    const templates = docs
      .map((d, i) => `${i + 1}. ${d.pageContent}`)
      .join('\n');
    return `You are an expert at matching user prompts to query templates. A template matches ONLY when its purpose and result are EXACTLY what the user asked — no extra columns, no missing filters, only placeholder values differ.

User prompt: ${prompt}
Templates:
${templates}

Return 'match <index>' for an exact match or 'no_match'. No other text.`;
  }

  /**
   * Table-level ACL gate (parity with v2 CheckTemplatesNode). A matched template
   * the user lacks read permission for is treated as no-match so the run falls
   * through to normal SQL generation (which enforces its own permissions) rather
   * than serving the template's data. Returns true when the template is allowed
   * (or when the gate can't run — fail-open here is safe because the read-time
   * ACL in DataSetHelper.getDataFromDataset still guards delivery).
   */
  protected async isTemplateAuthorised(templateId: string): Promise<boolean> {
    const {permissionHelper, templateStore} = this;
    if (!permissionHelper || !templateStore) return true;
    try {
      const template = await templateStore.findById(templateId);
      return (
        permissionHelper.findMissingPermissions(template.tables).length === 0
      );
    } catch {
      // Can't resolve the template's tables — let it fall through to the matcher
      // result; the read-time ACL remains the backstop.
      return true;
    }
  }

  /**
   * Resolve a `match <index>` judge verdict to a step result, applying the
   * upfront permission gate. Returns undefined for a non-match (or an
   * out-of-range / id-less doc) so the caller degrades to `{matched:false}`.
   */
  protected async resolveMatchedTemplate(
    rc: Rc,
    verdictText: string,
    docs: TemplateDoc[],
  ): Promise<TemplateMatchOut | undefined> {
    const match = /match\s+(\d+)/i.exec(verdictText);
    if (!match) return undefined;
    const doc = docs[Number.parseInt(match[1], 10) - 1];
    if (!doc?.metadata?.id) return undefined;
    // Upfront table-permission check (v2 parity): skip an unauthorized template
    // so the run falls through to normal generation rather than serving its data.
    if (!(await this.isTemplateAuthorised(doc.metadata.id))) {
      logStepDetail(
        DbQueryNodes.CheckTemplates,
        `Template matched but missing table permissions; skipping: ${doc.pageContent}`,
      );
      return {matched: false};
    }
    // Emit the client-facing match status only AFTER the ACL passes (v2 parity):
    // a forbidden template falls through silently, so its existence never leaks.
    emitToolStatus(rc, DbQueryNodes.CheckTemplates, 'Matched query template');
    logStepDetail(
      DbQueryNodes.CheckTemplates,
      `Template matched: ${doc.pageContent}`,
    );
    return {matched: true, templateId: doc.metadata.id};
  }
}
