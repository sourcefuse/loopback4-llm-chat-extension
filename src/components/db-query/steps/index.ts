// DI-backed workflow step implementations (the Mastra-named successors of the
// LangGraph `nodes/` classes). Each is an `@step(key)`-decorated injectable
// resolved by tag at run time; the Mastra workflow references only the key via
// a committed shell (see mastra/_step-shell). Register these in
// DbQueryComponent.services so they are discoverable + overrideable.
import type {IWorkflowStep, StepResolver} from '../../../graphs/types';
import {
  STEP_CHECK_CACHE,
  STEP_CHECK_TEMPLATES,
  STEP_FAILED,
  STEP_FIX_QUERY,
  STEP_GENERATE_CHECKLIST,
  STEP_GET_COLUMNS,
  STEP_GET_TABLES,
  STEP_IMPROVE_FAILED,
  STEP_LOAD_EXISTING,
  STEP_POST_CACHE_AND_TABLES,
  STEP_RETURN_CACHED,
  STEP_SAVE_DATASET,
  STEP_SAVE_FROM_TEMPLATE,
  STEP_SAVE_IMPROVED,
  STEP_SQL_AND_VALIDATE,
  STEP_VERIFY_CHECKLIST,
} from './constants';

import {CheckCacheStep} from './check-cache.step';
import {CheckTemplatesStep} from './check-templates.step';
import {FailedStep} from './failed.step';
import {FixQueryStep} from './fix-query.step';
import {GenerateChecklistStep} from './generate-checklist.step';
import {GetColumnsStep} from './get-columns.step';
import {GetTablesStep} from './get-tables.step';
import {ImproveFailedStep} from './improve-failed.step';
import {LoadExistingStep} from './load-existing.step';
import {PostCacheAndTablesStep} from './post-cache-and-tables.step';
import {ReturnCachedStep} from './return-cached.step';
import {SaveDatasetStep} from './save-dataset.step';
import {SaveDatasetFromTemplateStep} from './save-dataset-from-template.step';
import {SaveImprovedStep} from './save-improved.step';
import {SqlAndValidateStep} from './sql-and-validate.step';
import {VerifyChecklistStep} from './verify-checklist.step';

export {CheckCacheStep} from './check-cache.step';
export {CheckTemplatesStep} from './check-templates.step';
export {FailedStep} from './failed.step';
export {FixQueryStep} from './fix-query.step';
export {GenerateChecklistStep} from './generate-checklist.step';
export {GetColumnsStep} from './get-columns.step';
export {GetTablesStep} from './get-tables.step';
export {ImproveFailedStep} from './improve-failed.step';
export {LoadExistingStep} from './load-existing.step';
export {PostCacheAndTablesStep} from './post-cache-and-tables.step';
export {ReturnCachedStep} from './return-cached.step';
export {SaveDatasetStep} from './save-dataset.step';
export {SaveDatasetFromTemplateStep} from './save-dataset-from-template.step';
export {SaveImprovedStep} from './save-improved.step';
export {SqlAndValidateStep} from './sql-and-validate.step';
export {VerifyChecklistStep} from './verify-checklist.step';

/**
 * Every db-query workflow step class, in registration order. Spread into
 * DbQueryComponent.services so each is bound as a tagged service (discoverable
 * via `findByTag({STEP: key})` and overrideable by rebinding the same key).
 */
export const DB_QUERY_STEP_CLASSES: Array<new () => IWorkflowStep> = [
  CheckCacheStep,
  CheckTemplatesStep,
  FailedStep,
  FixQueryStep,
  GenerateChecklistStep,
  GetColumnsStep,
  GetTablesStep,
  ImproveFailedStep,
  LoadExistingStep,
  PostCacheAndTablesStep,
  ReturnCachedStep,
  SaveDatasetStep,
  SaveDatasetFromTemplateStep,
  SaveImprovedStep,
  SqlAndValidateStep,
  VerifyChecklistStep,
];

/**
 * resolverKey → step class, mirroring the `@step(key)` tags. The production
 * path resolves steps from the LB4 container (WorkflowRunner.resolveWorkflowStep
 * via `findByTag`); this static map is a CONVENIENCE for unit/integration tests
 * that drive a workflow WITHOUT booting the container — call
 * {@link makeStaticStepResolver} and set it as `resolveStep` on the test rc.
 */
export const DB_QUERY_STEP_BY_KEY: Record<string, new () => IWorkflowStep> = {
  [STEP_CHECK_CACHE]: CheckCacheStep,
  [STEP_CHECK_TEMPLATES]: CheckTemplatesStep,
  [STEP_FAILED]: FailedStep,
  [STEP_FIX_QUERY]: FixQueryStep,
  [STEP_GENERATE_CHECKLIST]: GenerateChecklistStep,
  [STEP_GET_COLUMNS]: GetColumnsStep,
  [STEP_GET_TABLES]: GetTablesStep,
  [STEP_IMPROVE_FAILED]: ImproveFailedStep,
  [STEP_LOAD_EXISTING]: LoadExistingStep,
  [STEP_POST_CACHE_AND_TABLES]: PostCacheAndTablesStep,
  [STEP_RETURN_CACHED]: ReturnCachedStep,
  [STEP_SAVE_DATASET]: SaveDatasetStep,
  [STEP_SAVE_FROM_TEMPLATE]: SaveDatasetFromTemplateStep,
  [STEP_SAVE_IMPROVED]: SaveImprovedStep,
  [STEP_SQL_AND_VALIDATE]: SqlAndValidateStep,
  [STEP_VERIFY_CHECKLIST]: VerifyChecklistStep,
};

/**
 * Build a {@link StepResolver} backed by {@link DB_QUERY_STEP_BY_KEY} for tests
 * that run a workflow without the LB4 container. NOT used in production.
 */
export function makeStaticStepResolver(): StepResolver {
  return async (key: string) => {
    const ctor = DB_QUERY_STEP_BY_KEY[key];
    if (!ctor) throw new Error(`No db-query step registered for key "${key}"`);
    return new ctor();
  };
}
