import {
  Binding,
  BindingKey,
  Context,
  CoreTags,
  createBindingFromClass,
} from '@loopback/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {GRAPH_NODE_NAME} from '../../constant';
import {AiIntegrationBindings} from '../../keys';
import {DbQueryAIExtensionBindings} from '../../components/db-query/keys';
import {VISUALIZATION_KEY} from '../../components/visualization/keys';
import {
  DB_QUERY_NODE_CLASSES,
  VISUALIZATION_NODE_CLASSES,
} from './node-registry';
import {SchemaStore} from '../../components/db-query/services/schema.store';
import {DataSetHelper} from '../../components/db-query/services/dataset-helper.service';
import {SqlGenerationHelper} from '../../components/db-query/services/sql-generation.service';
import type {IGraphNode, NodeResolver} from '../../graphs/types';

/**
 * Build a CONTAINER-backed {@link NodeResolver} for workflow tests, mirroring
 * WorkflowRunner.resolveGraphNode. Steps are now DI classes whose
 * collaborators are constructor-injected, so a test must bind the stub
 * collaborators into a real LB4 Context (not stuff them into the RequestContext)
 * and resolve steps from it. Pass the stubs you need; everything is optional so
 * a step that doesn't use a given collaborator just gets `undefined`.
 *
 * Returns the resolver to set as `resolveNode` on the test RequestContext, plus
 * the Context (so a test can bind extra keys if needed).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stub = any;
export interface NodeDeps {
  connector?: Stub;
  schemaStore?: Stub;
  schemaHelper?: Stub;
  dataSetHelper?: Stub;
  templateHelper?: Stub;
  permissionHelper?: Stub;
  datasetStore?: Stub;
  templateStore?: Stub;
  queryCache?: Stub;
  templateCache?: Stub;
  config?: Stub;
  globalContext?: string[];
  authUser?: Stub;
  visualizers?: Stub[];
  chatModel?: Stub;
  cheapModel?: Stub;
  smartModel?: Stub;
  smartNonThinkingModel?: Stub;
  sqlGenHelper?: Stub;
}

// Test schemaStore stubs provide get()/filteredSchema(); graft on the real
// read methods (allTableNames/tablesWithColumns/schemaForPrompt, which moved
// from _helpers onto SchemaStore) so steps calling them run against the stub.
// Extracted from makeContainerNodeResolver to keep it under the
// cyclomatic-complexity cap (S1541).
function schemaStoreWithRealMethods(schemaStore: Stub): Stub {
  return (
    schemaStore &&
    Object.assign(schemaStore, {
      allTableNames:
        schemaStore.allTableNames ?? SchemaStore.prototype.allTableNames,
      tablesWithColumns:
        schemaStore.tablesWithColumns ??
        SchemaStore.prototype.tablesWithColumns,
      schemaForPrompt:
        schemaStore.schemaForPrompt ?? SchemaStore.prototype.schemaForPrompt,
    })
  );
}

export function makeContainerNodeResolver(deps: NodeDeps = {}): {
  resolver: NodeResolver;
  ctx: Context;
} {
  const ctx = new Context('test-steps');

  for (const stepClass of [
    ...DB_QUERY_NODE_CLASSES,
    ...VISUALIZATION_NODE_CLASSES,
  ]) {
    ctx.add(createBindingFromClass(stepClass));
  }

  const bindIf = (key: string | BindingKey<unknown>, value: unknown) => {
    if (value !== undefined) ctx.bind(key).to(value as never);
  };
  bindIf(DbQueryAIExtensionBindings.Connector.key, deps.connector);
  bindIf('services.SchemaStore', schemaStoreWithRealMethods(deps.schemaStore));
  bindIf('services.DbSchemaHelperService', deps.schemaHelper);
  // If a test provides only a datasetStore (no dataSetHelper), synthesize a
  // DataSetHelper backed by it: the cache-step reads isCachedDatasetUsable /
  // loadSampleQuery moved onto DataSetHelper (they use `this.store`), so graft
  // the real methods + a permissive checkPermissions so the stub behaves like
  // a bound helper.
  const dataSetHelper =
    deps.dataSetHelper ??
    (deps.datasetStore && {
      store: deps.datasetStore,
      checkPermissions: async () => [],
      isCachedDatasetUsable: DataSetHelper.prototype.isCachedDatasetUsable,
      loadSampleQuery: DataSetHelper.prototype.loadSampleQuery,
    });
  bindIf('services.DataSetHelper', dataSetHelper);
  bindIf('services.TemplateHelper', deps.templateHelper);
  bindIf('services.PermissionHelper', deps.permissionHelper);
  bindIf(DbQueryAIExtensionBindings.DatasetStore.key, deps.datasetStore);
  bindIf(DbQueryAIExtensionBindings.TemplateStore.key, deps.templateStore);
  bindIf(DbQueryAIExtensionBindings.QueryCache.key, deps.queryCache);
  bindIf(DbQueryAIExtensionBindings.TemplateCache.key, deps.templateCache);
  bindIf(DbQueryAIExtensionBindings.Config.key, deps.config);
  bindIf(DbQueryAIExtensionBindings.GlobalContext.key, deps.globalContext);
  bindIf(AuthenticationBindings.CURRENT_USER, deps.authUser);
  bindIf(AiIntegrationBindings.ChatModel.key, deps.chatModel);
  bindIf(AiIntegrationBindings.CheapModel.key, deps.cheapModel);
  bindIf(AiIntegrationBindings.SmartModel.key, deps.smartModel);
  bindIf(
    AiIntegrationBindings.SmartNonThinkingModel.key,
    deps.smartNonThinkingModel,
  );
  // `@service(SqlGenerationHelper)` resolves via a ContextView filtered by
  // class/interface — NOT by binding key — so a plain-object stub must carry
  // the `serviceInterface` tag to be found (a bare `bindIf` key-binding, as
  // used for the `@inject('services.X')` collaborators above, is invisible
  // to `@service()` resolution).
  if (deps.sqlGenHelper !== undefined) {
    ctx
      .bind('services.SqlGenerationHelper')
      .to(deps.sqlGenHelper as never)
      .tag({[CoreTags.SERVICE_INTERFACE]: SqlGenerationHelper});
  }
  for (const vis of deps.visualizers ?? []) {
    ctx
      .bind(`visualizers.test.${(vis as {name?: string}).name ?? 'v'}`)
      .to(vis as never)
      .tag({[VISUALIZATION_KEY]: true});
  }

  const resolver: NodeResolver = async (key: string) => {
    const bindings = ctx.findByTag({[GRAPH_NODE_NAME]: key}) as Binding[];
    return ctx.get<IGraphNode>(bindings[0].key);
  };
  return {resolver, ctx};
}
