import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import type {DiscoveryRoutingDecision} from '../db-query-workflow-schemas';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

/**
 * DiscoveryRoutingStep — replaces PostCacheAndTables routing logic.
 *
 * Examines the merged results from cache-check, table-selection,
 * template-match, and change-classification to determine the next path:
 * - 'from-cache': exact cache hit → workflow complete (return dataset)
 * - 'from-template': template matched → go to save dataset
 * - 'failed': table selection failed → go to failure
 * - 'continue': proceed with column selection and SQL generation
 */
export const discoveryRoutingStep = createStep({
  id: 'discovery-routing',
  inputSchema: z.object({
    fromCache: z.boolean().optional(),
    fromTemplate: z.boolean().optional(),
    status: z.string().optional(),
    // Pass-through fields needed by subsequent steps
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
  execute: async ({inputData}) => {
    let route: DiscoveryRoutingDecision;

    if (inputData.fromTemplate) {
      route = 'from-template';
    } else if (inputData.fromCache) {
      route = 'from-cache';
    } else if (inputData.status === 'failed') {
      route = 'failed';
    } else {
      route = 'continue';
    }

    return {
      route,
      prompt: inputData.prompt,
      schema: inputData.schema,
      sql: inputData.sql,
      description: inputData.description,
      sampleSql: inputData.sampleSql,
      sampleSqlPrompt: inputData.sampleSqlPrompt,
      changeType: inputData.changeType,
      datasetId: inputData.datasetId,
      replyToUser: inputData.replyToUser,
      templateId: inputData.templateId,
      directCall: inputData.directCall,
    };
  },
});
