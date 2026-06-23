import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {emitToolStatus, getPermissionHelper, getSchemaStore} from '../_helpers';
import {inputSchema, STEP_GET_TABLES} from './constants';

type PermissionHelperLike = ReturnType<typeof getPermissionHelper>;

/**
 * Drop tables the user lacks read permission for (parity with v2
 * get-tables.node `_filterByPermissions`). Filtering here keeps unauthorized
 * tables out of the schema the SQL generator ever sees, so the generated query
 * can only reference accessible tables — defence in depth on top of the
 * read-time ACL in DataSetHelper.getDataFromDataset. Fail-open when no
 * PermissionHelper is bound (matches v2: no helper → no filtering).
 */
function filterByPermissions(
  tables: string[],
  permissionHelper: PermissionHelperLike,
): string[] {
  if (!permissionHelper) return tables;
  return tables.filter(t => {
    // strip the `schema.` prefix before the permission lookup (v2 parity)
    const name = t.toLowerCase().slice(t.indexOf('.') + 1);
    return permissionHelper.findMissingPermissions([name]).length === 0;
  });
}

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
      const tables = filterByPermissions(
        Object.keys(schema.tables),
        getPermissionHelper(requestContext),
      );
      return {tables};
    } catch {
      return {tables: []};
    }
  },
});
