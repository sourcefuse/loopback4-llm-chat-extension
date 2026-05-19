/**
 * Branch condition context types for DBQuery workflow branches.
 *
 * Mastra's `.branch()` and `.dountil()` condition functions receive the full
 * step execution context, not just the step output. The step output is in
 * the `inputData` field of this context.
 */

/**
 * The execution context passed to `.branch()` and `.dountil()` conditions.
 *
 * `inputData` contains the output of the preceding step or workflow.
 * `iterationCount` is available in `.dountil()` loops (1-based).
 */
export interface BranchContext<TInputData> {
  inputData: TInputData;
  iterationCount?: number;
  runId: string;
  workflowId: string;
}
