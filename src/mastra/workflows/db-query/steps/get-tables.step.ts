import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {emitToolStatus, getSchemaStore} from '../_helpers';
import {inputSchema, STEP_GET_TABLES} from './constants';

export const getTablesStep = createStep({
  id: STEP_GET_TABLES,
  inputSchema,
  outputSchema: z.object({tables: z.array(z.string())}),
  execute: async ({requestContext}) => {
    emitToolStatus(
      requestContext,
      STEP_GET_TABLES,
      'Extracting relevant tables from the schema',
    );

    const schemaStore = getSchemaStore(requestContext);
    if (!schemaStore) return {tables: []};

    try {
      const schema = schemaStore.get();
      return {tables: Object.keys(schema.tables)};
    } catch {
      return {tables: []};
    }
  },
});
