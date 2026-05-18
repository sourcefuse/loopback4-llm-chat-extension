import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import type {ValidationRoutingDecision} from '../db-query-workflow-schemas';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

/**
 * ValidationMergeStep — replaces PostValidation merge logic + routing.
 *
 * Merges syntactic + semantic validation results and determines routing:
 * - 'accepted': both pass → save dataset
 * - 'fix-query': query_error → attempt repair
 * - 'reselect-tables': table_not_found → re-run table selection
 * - 'failed': max attempts exceeded → failure
 */
export const validationMergeStep = createStep({
  id: 'validation-merge',
  inputSchema: z.object({
    // Validation results
    syntacticStatus: z.string().optional(),
    syntacticFeedback: z.string().optional(),
    syntacticErrorTables: z.array(z.string()).optional(),
    semanticStatus: z.string().optional(),
    semanticFeedback: z.string().optional(),
    semanticErrorTables: z.array(z.string()).optional(),
    // Description from parallel step
    description: z.string().optional(),
    // Existing state
    feedbacks: z.array(z.string()).optional(),
    sql: z.string().optional(),
    prompt: z.string(),
    schema: DatabaseSchemaZ,
    validationChecklist: z.string().optional(),
    directCall: z.boolean().optional(),
  }),
  outputSchema: z.object({
    route: z.enum(['accepted', 'fix-query', 'reselect-tables', 'failed']),
    status: z.string(),
    feedbacks: z.array(z.string()),
    syntacticErrorTables: z.array(z.string()).optional(),
    semanticErrorTables: z.array(z.string()).optional(),
    description: z.string().optional(),
    sql: z.string().optional(),
    prompt: z.string(),
    schema: DatabaseSchemaZ,
    validationChecklist: z.string().optional(),
    directCall: z.boolean().optional(),
  }),
  execute: async ({inputData}) => {
    const MAX_ATTEMPTS = 3;

    const hasSyntacticFailure = isValidationFailure(inputData.syntacticStatus);
    const hasSemanticFailure = isValidationFailure(inputData.semanticStatus);

    if (!hasSyntacticFailure && !hasSemanticFailure) {
      return buildAcceptedOutput(inputData);
    }

    const errorTables = mergeErrorTables(
      inputData.syntacticErrorTables,
      inputData.semanticErrorTables,
    );
    const allFeedbacks = buildFeedbacks(
      inputData.feedbacks,
      inputData.syntacticFeedback,
      inputData.semanticFeedback,
      hasSyntacticFailure,
    );
    const status = resolveValidationStatus(
      hasSyntacticFailure,
      inputData.syntacticStatus,
      inputData.semanticStatus,
    );
    const route = resolveValidationRoute(
      status,
      allFeedbacks.length,
      MAX_ATTEMPTS,
    );

    return {
      route,
      status,
      feedbacks: allFeedbacks,
      syntacticErrorTables: errorTables,
      semanticErrorTables: errorTables,
      description: inputData.description,
      sql: inputData.sql,
      prompt: inputData.prompt,
      schema: inputData.schema,
      validationChecklist: inputData.validationChecklist,
      directCall: inputData.directCall,
    };
  },
});

function buildAcceptedOutput(inputData: {
  feedbacks?: string[];
  description?: string;
  sql?: string;
  prompt: string;
  schema: z.infer<typeof DatabaseSchemaZ>;
  validationChecklist?: string;
  directCall?: boolean;
}) {
  return {
    route: 'accepted' as ValidationRoutingDecision,
    status: 'pass',
    feedbacks: (inputData.feedbacks ?? []).filter(
      feedback => !feedback.startsWith('Query Validation Failed'),
    ),
    description: inputData.description,
    sql: inputData.sql,
    prompt: inputData.prompt,
    schema: inputData.schema,
    validationChecklist: inputData.validationChecklist,
    directCall: inputData.directCall,
  };
}

function mergeErrorTables(
  syntacticErrorTables?: string[],
  semanticErrorTables?: string[],
): string[] | undefined {
  const mergedErrorTables = [
    ...new Set([
      ...(syntacticErrorTables ?? []),
      ...(semanticErrorTables ?? []),
    ]),
  ];
  return mergedErrorTables.length > 0 ? mergedErrorTables : undefined;
}

function buildFeedbacks(
  baseFeedbacks: string[] | undefined,
  syntacticFeedback: string | undefined,
  semanticFeedback: string | undefined,
  hasSyntacticFailure: boolean,
): string[] {
  const syntactic =
    hasSyntacticFailure && syntacticFeedback ? [syntacticFeedback] : [];
  const semantic = semanticFeedback ? [semanticFeedback] : [];
  return [...(baseFeedbacks ?? []), ...syntactic, ...semantic];
}

function resolveValidationStatus(
  hasSyntacticFailure: boolean,
  syntacticStatus: string | undefined,
  semanticStatus: string | undefined,
): string {
  return hasSyntacticFailure
    ? (syntacticStatus ?? 'query_error')
    : (semanticStatus ?? 'query_error');
}

function resolveValidationRoute(
  status: string,
  feedbackCount: number,
  maxAttempts: number,
): ValidationRoutingDecision {
  if (feedbackCount >= maxAttempts) {
    return 'failed';
  }
  if (status === 'table_not_found') {
    return 'reselect-tables';
  }
  if (status === 'query_error') {
    return 'fix-query';
  }
  return 'failed';
}

function isValidationFailure(status: string | undefined): boolean {
  return !!status && status !== 'pass';
}
