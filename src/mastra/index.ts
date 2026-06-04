// Advanced extension surface — Mastra workflow/agent building blocks.
//
// Import from `lb4-llm-chat-component/mastra` (NOT the package root) to compose
// custom workflows, swap an individual db-query step, or build a custom Mastra
// instance. Kept on a dedicated subpath because `generate.steps` exports the
// generic names `inputSchema` / `outputSchema` (re-exported here as
// `generateQueryInputSchema` / `generateQueryOutputSchema`) which would collide
// with the package-root `export *` barrel.

export {MastraProvider} from '../providers/mastra/mastra.provider';

// The three workflows registered on the Mastra singleton, by id:
//   generateQueryWorkflow -> 'generate-query'
//   improveQueryWorkflow  -> 'improve-query'
//   visualizationWorkflow -> 'visualization'
export {generateQueryWorkflow} from './workflows/db-query/generate.workflow';
export {improveQueryWorkflow} from './workflows/db-query/improve.workflow';
export {visualizationWorkflow} from './workflows/visualization.workflow';

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
} from './workflows/db-query/generate.steps';
