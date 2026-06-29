import {createStep} from '@mastra/core/workflows';
import {
  getDbQueryConfig,
  getSmartLlm,
  getSmartNonThinkingLlm,
} from '../_helpers';
import {
  CHECKLIST_MIN_TABLES,
  checklistStateSchema,
  mergeChecklist,
  selectDomainRules,
} from './checklist.shared';

/**
 * Second checklist pass (v2 verify-checklist.node). Re-evaluates the
 * GlobalContext + per-table domain rules with the SMART tier — optionally with
 * chain-of-thought (`verifyChecklistNode.evaluation`) — and merges the verified
 * rules into the checklist produced by generate-checklist. This is what makes
 * domain rules ENFORCED at semantic-validation time, not merely hinted to the
 * SQL generator.
 *
 * Self-gates to the same conditions under which generate produced no checklist
 * (cached/template result, unanswerable question, disabled, or ≤2 tables) and
 * is otherwise a pass-through, so the run shape is unchanged when there are no
 * domain rules to verify.
 */
export const verifyChecklistStep = createStep({
  id: 'verify-checklist',
  inputSchema: checklistStateSchema,
  outputSchema: checklistStateSchema,
  execute: async ({inputData, requestContext, tracingContext}) => {
    const data = inputData;
    const config = getDbQueryConfig(requestContext);
    const disabled = config?.nodes?.verifyChecklistNode?.enabled === false;

    if (
      disabled ||
      data.cached === true ||
      data.unanswerable === true ||
      data.tables.length <= CHECKLIST_MIN_TABLES
    ) {
      return data;
    }

    // Prefer the non-thinking smart model (thinking chunks pollute the
    // index-list parse), falling back to the smart tier (v2
    // `smartNonThinkingLlm ?? smartLlm`).
    const verifyLlm =
      getSmartNonThinkingLlm(requestContext) ?? getSmartLlm(requestContext);

    const verifiedRules = await selectDomainRules({
      rc: requestContext,
      llm: verifyLlm,
      prompt: data.prompt,
      tables: data.tables,
      label: 'verify-checklist',
      evaluation: config?.nodes?.verifyChecklistNode?.evaluation ?? false,
      tracing: tracingContext,
    });

    if (verifiedRules.length === 0) return data;

    return {...data, checklist: mergeChecklist(data.checklist, verifiedRules)};
  },
});
