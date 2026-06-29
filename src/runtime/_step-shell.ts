import {createStep} from '@mastra/core/workflows';
import type {RequestContext} from '@mastra/core/request-context';
import type {z} from 'zod';
import type {StepResolver, WorkflowStepCtx} from '../graphs/types';

/**
 * RequestContext key under which WorkflowRunner publishes the per-request
 * {@link StepResolver}. The committed step shell reads it to fetch its
 * DI-backed implementation. Kept here (not in db-query `_helpers`) so the shell
 * stays domain-agnostic and reusable by any workflow.
 */
export const STEP_RESOLVER_KEY = 'resolveStep';

/**
 * Build a Mastra step that owns NO logic — it is a thin, committed shell whose
 * `id` + schemas are fixed at workflow-build time (Mastra's commit-once
 * constraint), and whose `execute` delegates to a `@step(resolverKey)` class
 * resolved from the LB4 container per request.
 *
 * This is the Mastra equivalent of LangGraph's `addNode(key, getNodeFn(key))`:
 * the workflow DAG references a step by `id`, while the actual implementation
 * comes from DI — so it is unit-testable, rebindable, and overrideable by a
 * host app exactly as the old `@graphNode` classes were.
 *
 * `resolverKey` defaults to `id` but is kept separate because two steps can
 * legitimately share a Mastra `id` across different workflows (the generate
 * `failed` step and the improve `failed` step both use id `'failed'`), while
 * the DI tag key must be globally unique. The whole Mastra execute context is
 * forwarded unchanged, so fan-in steps still receive `getStepResult`.
 */
export function makeStepShell(opts: {
  id: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  resolverKey?: string;
}) {
  const resolverKey = opts.resolverKey ?? opts.id;
  return createStep({
    id: opts.id,
    inputSchema: opts.inputSchema,
    outputSchema: opts.outputSchema,
    execute: async ctx => {
      const resolve = (ctx.requestContext as RequestContext).get(
        STEP_RESOLVER_KEY,
      ) as StepResolver | undefined;
      if (!resolve) {
        throw new Error(
          `Workflow step "${opts.id}" is a DI shell but no step resolver was ` +
            `found in RequestContext. Ensure WorkflowRunner populated it (the ` +
            `step must be run via the bundled runner, not a detached workflow run).`,
        );
      }
      const stepImpl = await resolve(resolverKey);
      return stepImpl.execute(ctx as unknown as WorkflowStepCtx);
    },
  });
}
