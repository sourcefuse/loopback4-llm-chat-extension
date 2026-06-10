// Advanced extension surface — Mastra workflow/agent building blocks.
//
// Import from `lb4-llm-chat-component/mastra` (NOT the package root) to compose
// custom workflows, swap an individual db-query step, or build a custom Mastra
// instance. Kept on a dedicated subpath because the db-query `steps` barrel exports the
// generic names `inputSchema` / `outputSchema` (re-exported here as
// `generateQueryInputSchema` / `generateQueryOutputSchema`) which would collide
// with the package-root `export *` barrel.

export {MastraProvider} from '../providers/mastra/mastra.provider';

// The three workflows registered on the Mastra singleton, by id:
//   generateQueryWorkflow -> 'generate-query'
//   improveQueryWorkflow  -> 'improve-query'
//   visualizationWorkflow -> 'visualization'
export {generateQueryWorkflow} from './workflows/db-query/workflows/generate.workflow';
export {improveQueryWorkflow} from './workflows/db-query/workflows/improve.workflow';
export {visualizationWorkflow} from './workflows/visualization/workflows/visualization.workflow';

// Individual db-query generate steps — import the ones you keep, substitute your
// own `createStep`, and recompose a workflow (see README "Overriding ... steps").
export {
  MAX_VALIDATION_ATTEMPTS,
  checkCacheStep,
  getTablesStep,
  checkTemplatesStep,
  postCacheAndTablesStep,
  returnCachedStep,
  saveDatasetFromTemplateStep,
  failedStep,
  getColumnsStep,
  generateChecklistStep,
  sqlAndValidateStep,
  saveDatasetStep,
  inputSchema as generateQueryInputSchema,
  outputSchema as generateQueryOutputSchema,
} from './workflows/db-query/steps';

// Pure relevant-table-selection helper (the LLM narrowing that runs inside
// getColumnsStep). Exported so hosts can unit-test table selection WITHOUT an
// app boot or a RequestContext:
//   pickRelevantTables({chatLlm, prompt, tablesWithColumns, upstreamTables})
//     -> {kind: 'tables', tables} | {kind: 'unanswerable', reason} | {kind: 'unknown'}
// This is the Mastra equivalent of the deleted LangGraph GetTablesNode test seam.
export {pickRelevantTables} from './workflows/db-query/_helpers';
export type {RelevantTablesResult} from './workflows/db-query/_helpers';
