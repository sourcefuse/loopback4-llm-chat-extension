/**
 * Step output interfaces for the DBQuery workflow.
 *
 * Extracted from the workflow file to provide a single source of truth for
 * step I/O contracts used across sub-workflows and composition boundaries.
 */

import type {AnyObject} from '@loopback/repository';
import type {DatabaseSchema} from '../../../../components/db-query/types';

// ── Dataset resolution ────────────────────────────────────────────────────

export interface DatasetResolutionOut {
  prompt: string;
  sampleSql?: string;
  sampleSqlPrompt?: string;
}

// ── Discovery steps ────────────────────────────────────────────────────────

export interface CacheCheckOut {
  fromCache?: boolean;
  sampleSql?: string;
  sampleSqlPrompt?: string;
  datasetId?: string;
  replyToUser?: string;
}

export interface TableSelectionOut {
  schema?: DatabaseSchema;
  status?: string;
  replyToUser?: string;
}

export interface TemplateMatchOut {
  sql?: string;
  description?: string;
  fromTemplate?: boolean;
  templateId?: string;
}

export interface ChangeClassificationOut {
  changeType?: 'minor' | 'major' | 'rewrite';
}

export interface DiscoveryRoutingOut {
  route: 'from-cache' | 'from-template' | 'continue' | 'failed';
  prompt: string;
  schema?: DatabaseSchema;
  sql?: string;
  description?: string;
  sampleSql?: string;
  sampleSqlPrompt?: string;
  changeType?: 'minor' | 'major' | 'rewrite';
  datasetId?: string;
  replyToUser?: string;
  templateId?: string;
  directCall?: boolean;
}

// ── Column selection and checklist ─────────────────────────────────────────

export interface ColumnSelectionOut {
  schema: DatabaseSchema;
  status?: string;
  replyToUser?: string;
}

export interface ChecklistOut {
  validationChecklist?: string;
}

// ── SQL generation and repair ──────────────────────────────────────────────

export interface SqlGenerationOut {
  sql?: string;
  status?: string;
  replyToUser?: string;
}

export interface QueryRepairOut {
  sql?: string;
  status?: string;
  replyToUser?: string;
}

// ── Validation steps ───────────────────────────────────────────────────────

export interface SyntacticValidationOut {
  syntacticStatus: string;
  syntacticFeedback?: string;
  syntacticErrorTables?: string[];
}

export interface SemanticValidationOut {
  semanticStatus: string;
  semanticFeedback?: string;
  semanticErrorTables?: string[];
}

export interface DescriptionGenerationOut {
  description?: string;
}

export interface ValidationMergeOut {
  route: 'accepted' | 'fix-query' | 'reselect-tables' | 'failed';
  status: string;
  feedbacks: string[];
  syntacticErrorTables?: string[];
  semanticErrorTables?: string[];
  description?: string;
  sql?: string;
  prompt: string;
  schema: DatabaseSchema;
  validationChecklist?: string;
  directCall?: boolean;
}

// ── Persistence ───────────────────────────────────────────────────────────

export interface DatasetPersistenceOut {
  datasetId?: string;
  replyToUser?: string;
  done?: boolean;
  resultArray?: AnyObject[];
}

export interface FailureOut {
  replyToUser: string;
}

// ── Validation cycle (composite) ──────────────────────────────────────────

/** Output of one iteration of the SQL validation cycle (ValidationMergeOut + loop state). */
export interface ValidationCycleOut extends ValidationMergeOut {
  fixAttempts: number;
  changeType?: 'minor' | 'major' | 'rewrite';
  sampleSql?: string;
  sampleSqlPrompt?: string;
  fromCache?: boolean;
  replyToUser?: string;
}
