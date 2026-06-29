import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  emitToolStatus,
  getCheapLlm,
  getPermissionHelper,
  getTemplateCache,
  getTemplateStore,
  logStepDetail,
  tracedGenerateText,
} from '../_helpers';
import {inputSchema, STEP_CHECK_TEMPLATES} from './constants';

/**
 * Table-level ACL gate (parity with v2 CheckTemplatesNode). A matched template
 * the user lacks read permission for is treated as no-match so the run falls
 * through to normal SQL generation (which enforces its own permissions) rather
 * than serving the template's data. Returns true when the template is allowed
 * (or when the gate can't run — fail-open here is safe because the read-time
 * ACL in DataSetHelper.getDataFromDataset still guards delivery).
 */
async function isTemplateAuthorised(
  requestContext: Parameters<typeof getPermissionHelper>[0],
  templateId: string,
): Promise<boolean> {
  const permissionHelper = getPermissionHelper(requestContext);
  const templateStore = getTemplateStore(requestContext);
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
 * Extracted from execute() to keep its complexity + nesting under the limits.
 */
async function resolveMatchedTemplate(
  requestContext: Parameters<typeof getPermissionHelper>[0],
  verdictText: string,
  docs: TemplateDoc[],
): Promise<MatchResult | undefined> {
  const match = /match\s+(\d+)/i.exec(verdictText);
  if (!match) return undefined;
  emitToolStatus(
    requestContext,
    STEP_CHECK_TEMPLATES,
    'Matched query template',
  );
  const doc = docs[Number.parseInt(match[1], 10) - 1];
  if (!doc?.metadata?.id) return undefined;
  // Upfront table-permission check (v2 parity): skip an unauthorized template
  // so the run falls through to normal generation rather than serving its data.
  if (!(await isTemplateAuthorised(requestContext, doc.metadata.id))) {
    logStepDetail(
      STEP_CHECK_TEMPLATES,
      `Template matched but missing table permissions; skipping: ${doc.pageContent}`,
    );
    return {matched: false};
  }
  logStepDetail(STEP_CHECK_TEMPLATES, `Template matched: ${doc.pageContent}`);
  return {matched: true, templateId: doc.metadata.id};
}

export const checkTemplatesStep = createStep({
  id: STEP_CHECK_TEMPLATES,
  inputSchema,
  outputSchema: z.object({
    matched: z.boolean(),
    templateId: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, tracingContext}) => {
    const data = inputData as {prompt?: string};
    if (!data.prompt) return {matched: false};

    const cache = getTemplateCache(requestContext);
    const chatLlm = getCheapLlm(requestContext);
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
      );
      if (resolved) return resolved;
    } catch {
      // degrade to no match on judge failure
    }

    return {matched: false};
  },
});
