import {inject} from '@loopback/core';
import {z} from 'zod';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import type {PermissionHelper} from '../services';
import type {SchemaStore} from '../services/schema.store';
import {emitToolStatus} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';

/** Output contract — mirrors the shell's `outputSchema`. */
export const getTablesOutputSchema = z.object({tables: z.array(z.string())});

type GetTablesOut = z.infer<typeof getTablesOutputSchema>;

/**
 * Extract the schema's table names the user may read (the Mastra-named
 * successor of the LangGraph `GetTablesNode`). An injectable `@step` class
 * resolved by tag at run time, so a host app overrides it by binding its own
 * `@graphNode('get-tables')` class. Collaborators (SchemaStore, PermissionHelper)
 * are constructor-injected — fail-soft when unbound (empty table set).
 */
@graphNode(DbQueryNodes.GetTables)
export class GetTablesNode implements IGraphNode<
  {prompt?: string},
  GetTablesOut
> {
  constructor(
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject('services.PermissionHelper', {optional: true})
    private readonly permissionHelper?: PermissionHelper,
  ) {}

  async execute({requestContext}: GraphNodeCtx): Promise<GetTablesOut> {
    emitToolStatus(
      requestContext,
      DbQueryNodes.GetTables,
      'Extracting relevant tables from the schema',
    );

    if (!this.schemaStore) return {tables: []};

    try {
      const schema = this.schemaStore.get();
      const allTables = Object.keys(schema.tables);
      // Fail-open when no PermissionHelper is bound (partial-config deployments).
      const tables =
        this.permissionHelper?.filterAuthorizedTables(allTables) ?? allTables;
      return {tables};
    } catch {
      return {tables: []};
    }
  }
}
