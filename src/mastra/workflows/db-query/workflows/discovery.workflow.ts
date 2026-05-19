import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';
import {cacheCheckStep} from '../steps/cache-check.step';
import {tableSelectionStep} from '../steps/table-selection.step';
import {templateMatchStep} from '../steps/template-match.step';
import {changeClassificationStep} from '../steps/change-classification.step';
import {discoveryRoutingStep} from '../steps/discovery-routing.step';

/**
 * DiscoveryWorkflow — determines how to proceed for a given prompt.
 *
 * Runs four independent discovery steps in parallel, then merges and routes:
 *  - CacheCheck: checks if a cached dataset matches the request
 *  - TableSelection: selects relevant DB tables from the schema
 *  - TemplateMatch: checks for a pre-existing SQL template
 *  - ChangeClassification: classifies the type of change (minor/major/rewrite)
 *
 * Routes:
 *  - `from-cache`    → cached SQL found, skip generation
 *  - `from-template` → SQL template matched, skip generation
 *  - `failed`        → table selection failed, cannot continue
 *  - `continue`      → proceed with column selection + SQL generation
 */
const discoveryInputSchema = z.object({
  prompt: z.string(),
  schema: DatabaseSchemaZ,
  sampleSql: z.string().optional(),
  sampleSqlPrompt: z.string().optional(),
  directCall: z.boolean().optional(),
  datasetId: z.string().optional(),
});

type DiscoveryInput = z.infer<typeof discoveryInputSchema>;

export const discoveryWorkflow = createWorkflow({
  id: 'discovery',
  inputSchema: discoveryInputSchema,
  outputSchema: z.object({
    route: z.enum(['from-cache', 'from-template', 'continue', 'failed']),
    prompt: z.string(),
    schema: DatabaseSchemaZ.optional(),
    sql: z.string().optional(),
    description: z.string().optional(),
    sampleSql: z.string().optional(),
    sampleSqlPrompt: z.string().optional(),
    changeType: z.enum(['minor', 'major', 'rewrite']).optional(),
    datasetId: z.string().optional(),
    replyToUser: z.string().optional(),
    templateId: z.string().optional(),
    directCall: z.boolean().optional(),
  }),
})
  .parallel([
    cacheCheckStep,
    tableSelectionStep,
    templateMatchStep,
    changeClassificationStep,
  ])
  .map(async ({inputData, getInitData}) => {
    const initData = getInitData<DiscoveryInput>();
    return {
      fromCache: inputData['cache-check'].fromCache,
      fromTemplate: inputData['template-match'].fromTemplate,
      status: inputData['table-selection'].status,
      prompt: initData.prompt,
      schema: inputData['table-selection'].schema ?? initData.schema,
      sql: inputData['template-match'].sql,
      description: inputData['template-match'].description,
      sampleSql: inputData['cache-check'].sampleSql ?? initData.sampleSql,
      sampleSqlPrompt:
        inputData['cache-check'].sampleSqlPrompt ?? initData.sampleSqlPrompt,
      changeType: inputData['change-classification'].changeType,
      datasetId: inputData['cache-check'].datasetId ?? initData.datasetId,
      replyToUser:
        inputData['cache-check'].replyToUser ??
        inputData['table-selection'].replyToUser,
      templateId: inputData['template-match'].templateId,
      directCall: initData.directCall,
    };
  })
  .then(discoveryRoutingStep)
  .commit();
