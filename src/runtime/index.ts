// Advanced extension surface — Mastra workflow/agent building blocks.
//
// Import from `lb4-llm-chat-component/mastra` (NOT the package root) to compose
// custom workflows, override an individual step, or build a custom Mastra
// instance. The db-query and visualization flows now live entirely under their
// LB4 components (`components/db-query`, `components/visualization`); this
// subpath just re-exports the pieces consumers compose against. Kept on a
// dedicated subpath because the step schemas use generic names
// (`inputSchema`/`outputSchema`, re-exported here as
// `generateQueryInputSchema`/`generateQueryOutputSchema`) that would collide
// with the package-root `export *` barrel.

export {MastraProvider} from '../providers/mastra/mastra.provider';

// The three workflows registered on the Mastra singleton, by id:
//   generateQueryWorkflow -> 'generate-query'
//   improveQueryWorkflow  -> 'improve-query'
//   visualizationWorkflow -> 'visualization'
export {generateQueryWorkflow} from '../components/db-query/workflows/generate.workflow';
export {improveQueryWorkflow} from '../components/db-query/workflows/improve.workflow';
export {visualizationWorkflow} from '../components/visualization/workflows/visualization.workflow';

// Individual db-query generate step SHELLS — reuse the ones you keep when
// recomposing a custom workflow (see README "Steps and workflows"). To override
// the LOGIC of a step, bind your own `@graphNode(key)` class instead (the simpler
// path) — `step` + `IGraphNode` are on the package root.
export {
  checkCacheNode,
  getTablesNode,
  checkTemplatesNode,
  postCacheAndTablesNode,
  returnCachedNode,
  saveDatasetFromTemplateNode,
  failedNode,
  getColumnsNode,
  generateChecklistNode,
  verifyChecklistNode,
  sqlAndValidateNode,
  saveDatasetNode,
} from '../components/db-query/workflows/generate.workflow';

// Step keys + the workflow input/output contract.
export {
  MAX_VALIDATION_ATTEMPTS,
  inputSchema as generateQueryInputSchema,
  outputSchema as generateQueryOutputSchema,
} from '../components/db-query/constants';

// Pure relevant-table-selection helper (the LLM narrowing that runs inside
// getColumnsNode). Exported so hosts can unit-test table selection WITHOUT an
// app boot or a RequestContext:
//   pickRelevantTables({chatLlm, prompt, tablesWithColumns, upstreamTables})
//     -> {kind: 'tables', tables} | {kind: 'unanswerable', reason} | {kind: 'unknown'}
// This is the Mastra equivalent of the deleted LangGraph GetTablesNode test seam.
export {pickRelevantTables} from '../components/db-query/_helpers';
export type {RelevantTablesResult} from '../components/db-query/_helpers';
