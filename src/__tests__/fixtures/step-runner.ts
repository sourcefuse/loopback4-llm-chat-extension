/**
 * Utility for calling a `createStep`-created step directly in unit tests,
 * without spinning up the full Mastra workflow runtime.
 *
 * Safe when the step's execute function only uses `inputData` from the params
 * (i.e. it does not depend on Mastra runtime fields like `runId` or `mastra`).
 *
 * @example
 * const result = await runStep(isImprovementStep, {state, context, deps: {store}});
 */
export function runStep<TOut>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: {execute: (p: any) => Promise<TOut>},
  data: unknown,
): Promise<TOut> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return step.execute({inputData: data} as any);
}
