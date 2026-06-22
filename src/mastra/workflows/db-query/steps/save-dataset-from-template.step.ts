import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  computeSchemaHash,
  getAuthUser,
  getDatasetStore,
  getSchemaHelper,
  getSchemaStore,
  getTemplateHelper,
  getTemplateStore,
  idToString,
  resolvePersistDeps,
  resolveTemplateById,
} from '../_helpers';
import {branchTemplateSchema} from './constants';

export const saveDatasetFromTemplateStep = createStep({
  id: 'save-dataset-from-template',
  inputSchema: z.any(),
  outputSchema: branchTemplateSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      templateId?: string;
      prompt?: string;
      tables?: string[];
    };
    const fallback = {kind: 'template' as const, datasetId: '', sql: ''};
    if (!data.templateId || !data.prompt) return fallback;

    const persist = resolvePersistDeps(
      getDatasetStore(requestContext),
      getAuthUser(requestContext),
    );
    if (!persist) return fallback;

    const resolved = await resolveTemplateById({
      templateStore: getTemplateStore(requestContext),
      templateHelper: getTemplateHelper(requestContext),
      schemaStore: getSchemaStore(requestContext),
      templateId: data.templateId,
      prompt: data.prompt,
    });
    if (!resolved) return fallback;

    const {schemaHash} = computeSchemaHash(
      getSchemaHelper(requestContext),
      getSchemaStore(requestContext),
    );

    const dataset = await persist.store.create({
      tenantId: persist.user.tenantId,
      query: resolved.sql,
      description: resolved.description ?? '',
      prompt: data.prompt,
      tables: data.tables ?? [],
      schemaHash,
      votes: 0,
    });

    return {
      kind: 'template' as const,
      datasetId: idToString(dataset.id),
      sql: resolved.sql,
    };
  },
});
