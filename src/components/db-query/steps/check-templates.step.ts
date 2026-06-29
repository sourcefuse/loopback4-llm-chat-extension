import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {InternalBindings} from '../../../runtime/internal-bindings';
import {DbQueryAIExtensionBindings} from '../keys';
import type {PermissionHelper} from '../services';
import type {IQueryTemplateStore} from '../types';
import {emitToolStatus, logStepDetail, tracedGenerateText} from './_helpers';
import {STEP_CHECK_TEMPLATES} from './constants';

type Rc = Parameters<typeof emitToolStatus>[0];
type TemplateCollaborators = {
  permissionHelper?: PermissionHelper;
  templateStore?: IQueryTemplateStore;
};
type TemplateCache = {
  invoke(
    input: string,
  ): Promise<Array<{pageContent: string; metadata: {id?: string}}>>;
};

/**
 * Table-level ACL gate (parity with v2 CheckTemplatesNode). A matched template
 * the user lacks read permission for is treated as no-match so the run falls
 * through to normal SQL generation (which enforces its own permissions) rather
 * than serving the template's data. Returns true when the template is allowed
 * (or when the gate can't run — fail-open here is safe because the read-time
 * ACL in DataSetHelper.getDataFromDataset still guards delivery).
 */
async function isTemplateAuthorised(
  templateId: string,
  collaborators: TemplateCollaborators,
): Promise<boolean> {
  const {permissionHelper, templateStore} = collaborators;
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

type TemplateDoc = {pageContent: string; metadata: {id?: string}};
type MatchResult = {matched: boolean; templateId?: string};

/**
 * Resolve a `match <index>` judge verdict to a step result, applying the
 * upfront permission gate. Returns undefined for a non-match (or an
 * out-of-range / id-less doc) so the caller degrades to `{matched:false}`.
 */
async function resolveMatchedTemplate(
  rc: Rc,
  verdictText: string,
  docs: TemplateDoc[],
  collaborators: TemplateCollaborators,
): Promise<MatchResult | undefined> {
  const match = /match\s+(\d+)/i.exec(verdictText);
  if (!match) return undefined;
  const doc = docs[Number.parseInt(match[1], 10) - 1];
  if (!doc?.metadata?.id) return undefined;
  // Upfront table-permission check (v2 parity): skip an unauthorized template
  // so the run falls through to normal generation rather than serving its data.
  if (!(await isTemplateAuthorised(doc.metadata.id, collaborators))) {
    logStepDetail(
      STEP_CHECK_TEMPLATES,
      `Template matched but missing table permissions; skipping: ${doc.pageContent}`,
    );
    return {matched: false};
  }
  // Emit the client-facing match status only AFTER the ACL passes (v2 parity):
  // a forbidden template falls through silently, so its existence never leaks.
  emitToolStatus(rc, STEP_CHECK_TEMPLATES, 'Matched query template');
  logStepDetail(STEP_CHECK_TEMPLATES, `Template matched: ${doc.pageContent}`);
  return {matched: true, templateId: doc.metadata.id};
}

type TemplateOut = {matched: boolean; templateId?: string};

/**
 * Query-template gate (the Mastra-named successor of the LangGraph
 * CheckTemplatesNode). DI-resolved `@step` class with constructor-injected
 * collaborators (template cache, template store, permission helper, cheap LLM
 * tier).
 */
@step(STEP_CHECK_TEMPLATES)
export class CheckTemplatesStep implements IWorkflowStep<
  {prompt?: string},
  TemplateOut
> {
  constructor(
    @inject(DbQueryAIExtensionBindings.TemplateCache, {optional: true})
    private readonly templateCache?: TemplateCache,
    @inject(DbQueryAIExtensionBindings.TemplateStore, {optional: true})
    private readonly templateStore?: IQueryTemplateStore,
    @inject('services.PermissionHelper', {optional: true})
    private readonly permissionHelper?: PermissionHelper,
    @inject(InternalBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(InternalBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
  ) {}

  async execute({
    inputData,
    requestContext,
    tracingContext,
  }: WorkflowStepCtx<{prompt?: string}>): Promise<TemplateOut> {
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

    const templates = docs
      .map((d, i) => `${i + 1}. ${d.pageContent}`)
      .join('\n');
    const judgePrompt = `You are an expert at matching user prompts to query templates. A template matches ONLY when its purpose and result are EXACTLY what the user asked — no extra columns, no missing filters, only placeholder values differ.

User prompt: ${data.prompt}
Templates:
${templates}

Return 'match <index>' for an exact match or 'no_match'. No other text.`;

    try {
      const verdict = await tracedGenerateText({
        model: chatLlm,
        prompt: judgePrompt,
        tracing: tracingContext,
        label: 'template-judge',
        resultType: 'reasoning',
      });
      const resolved = await resolveMatchedTemplate(
        requestContext,
        verdict.text.trim(),
        docs,
        {
          permissionHelper: this.permissionHelper,
          templateStore: this.templateStore,
        },
      );
      if (resolved) return resolved;
    } catch {
      // degrade to no match on judge failure
    }

    return {matched: false};
  }
}
