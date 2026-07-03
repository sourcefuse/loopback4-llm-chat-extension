import {
  Binding,
  BindingKey,
  Context,
  createBindingFromClass,
} from '@loopback/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {STEP_DEFAULT, STEP_NAME} from '../../constant';
import {AiIntegrationBindings} from '../../keys';
import {DbQueryAIExtensionBindings} from '../../components/db-query/keys';
import {VISUALIZATION_KEY} from '../../components/visualization/keys';
import {DB_QUERY_STEP_CLASSES} from '../../components/db-query/steps';
import {VISUALIZATION_STEP_CLASSES} from '../../components/visualization/steps';
import {SchemaStore} from '../../components/db-query/services/schema.store';
import type {IWorkflowStep, StepResolver} from '../../graphs/types';

/**
 * Build a CONTAINER-backed {@link StepResolver} for workflow tests, mirroring
 * WorkflowRunner.resolveWorkflowStep. Steps are now DI classes whose
 * collaborators are constructor-injected, so a test must bind the stub
 * collaborators into a real LB4 Context (not stuff them into the RequestContext)
 * and resolve steps from it. Pass the stubs you need; everything is optional so
 * a step that doesn't use a given collaborator just gets `undefined`.
 *
 * Returns the resolver to set as `resolveStep` on the test RequestContext, plus
 * the Context (so a test can bind extra keys if needed).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stub = any;
export interface StepDeps {
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
}

export function makeContainerStepResolver(deps: StepDeps = {}): {
  resolver: StepResolver;
  ctx: Context;
} {
  const ctx = new Context('test-steps');

  for (const stepClass of [
    ...DB_QUERY_STEP_CLASSES,
    ...VISUALIZATION_STEP_CLASSES,
  ]) {
    ctx.add(createBindingFromClass(stepClass).tag({[STEP_DEFAULT]: true}));
  }

  const bindIf = (key: string | BindingKey<unknown>, value: unknown) => {
    if (value !== undefined) ctx.bind(key).to(value as never);
  };
  bindIf(DbQueryAIExtensionBindings.Connector.key, deps.connector);
  // Test schemaStore stubs provide get()/filteredSchema(); graft on the real
  // read methods (allTableNames/tablesWithColumns/schemaForPrompt, which moved
  // from _helpers onto SchemaStore) so steps calling them run against the stub.
  bindIf(
    'services.SchemaStore',
    deps.schemaStore &&
      Object.assign(deps.schemaStore, {
        allTableNames:
          deps.schemaStore.allTableNames ?? SchemaStore.prototype.allTableNames,
        tablesWithColumns:
          deps.schemaStore.tablesWithColumns ??
          SchemaStore.prototype.tablesWithColumns,
        schemaForPrompt:
          deps.schemaStore.schemaForPrompt ??
          SchemaStore.prototype.schemaForPrompt,
      }),
  );
  bindIf('services.DbSchemaHelperService', deps.schemaHelper);
  bindIf('services.DataSetHelper', deps.dataSetHelper);
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
  for (const vis of deps.visualizers ?? []) {
    ctx
      .bind(`visualizers.test.${(vis as {name?: string}).name ?? 'v'}`)
      .to(vis as never)
      .tag({[VISUALIZATION_KEY]: true});
  }

  const resolver: StepResolver = async (key: string) => {
    const bindings = ctx.findByTag({[STEP_NAME]: key}) as Binding[];
    const overrides = bindings.filter(b => !b.tagMap[STEP_DEFAULT]);
    const chosen = overrides.length > 0 ? overrides : bindings;
    return ctx.get<IWorkflowStep>(chosen[0].key);
  };
  return {resolver, ctx};
}
