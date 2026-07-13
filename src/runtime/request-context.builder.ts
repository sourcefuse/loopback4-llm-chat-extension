import {BindingScope, Context, inject, injectable} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {RequestContext} from '@mastra/core/request-context';
import type {MastraModelConfig} from '@mastra/core/llm';
import type {LanguageModel} from 'ai';
import type {Tool} from '@mastra/core/tools';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {AiIntegrationBindings} from '../keys';
import type {LLMStreamEvent} from '../graphs/event.types';
import type {ToolStore} from '../types';
import {buildChatInstructions} from './chat-agent-instructions';
import {resolveAiSdkModel} from './model-resolver';
import {resolveNodeFromContext} from '../graphs/base.graph';
import {DbQueryAIExtensionBindings} from '../components/db-query/keys';
import type {
  DbQueryConfig,
  IDataSetStore,
  IDbConnector,
  IQueryTemplateStore,
} from '../components/db-query/types';
import type {
  DataSetHelper,
  DbSchemaHelperService,
  PermissionHelper,
  TemplateHelper,
} from '../components/db-query/services';
import type {SchemaStore} from '../components/db-query/services/schema.store';
import {VISUALIZATION_KEY} from '../components/visualization/keys';
import type {IVisualizer} from '../components/visualization/types';
import type {MastraRcShape} from '../components/db-query/_helpers';

/**
 * Assembles the per-request Mastra {@link RequestContext} the chat agent + the
 * db-query/visualization workflow tools read. This is Mastra-runtime glue with
 * no LangGraph node analog (LangGraph bound tools via `llm.bindTools` and had no
 * RequestContext), so it lives in `runtime/` rather than bloating CallLLMNode.
 *
 * REQUEST-scoped: it reads the request-scoped bindings + authenticated user.
 * Injected into CallLLMNode via `@service`.
 */
@injectable({scope: BindingScope.REQUEST})
export class RequestContextBuilder {
  constructor(
    @inject.context() protected readonly lb4Ctx: Context,
    @inject(AiIntegrationBindings.Mastra) protected readonly mastra: Mastra,
    @inject(AiIntegrationBindings.ChatLLM, {optional: true})
    protected readonly chatLlm?: MastraModelConfig,
    @inject(AiIntegrationBindings.CheapLLM, {optional: true})
    protected readonly cheapLlm?: MastraModelConfig,
    @inject(AiIntegrationBindings.SmartLLM, {optional: true})
    protected readonly smartLlm?: MastraModelConfig,
    @inject(AiIntegrationBindings.SmartNonThinkingLLM, {optional: true})
    protected readonly smartNonThinkingLlm?: MastraModelConfig,
    @inject(AiIntegrationBindings.Tools, {optional: true})
    protected readonly mastraTools?: ToolStore,
    @inject(AiIntegrationBindings.SystemContext, {optional: true})
    protected readonly systemContext?: string[],
  ) {}

  /**
   * Build the RequestContext for this run and publish the resolved model tiers
   * as container bindings (so committed workflow step shells can `@inject` a
   * ready-to-call model).
   */
  async build(args: {
    resourceId: string;
    eventWriter: (event: LLMStreamEvent) => void;
  }): Promise<RequestContext<MastraRcShape>> {
    const shape = await this.resolveShape(args);
    const ctx = new RequestContext<MastraRcShape>();
    this.populate(ctx, shape);
    this.bindRuntimeModels(shape);
    return ctx;
  }

  protected buildToolMap(): Record<string, Tool> {
    if (!this.mastraTools) return {};
    return Object.fromEntries(
      this.mastraTools.list.map(t => [t.key, t.build()]),
    );
  }

  protected buildInstructions(): string {
    // `Current date is …` restores LangGraph init-session.node: without it the
    // agent has no notion of "today". buildChatInstructions computes it per
    // request and appends the host `systemContext` last.
    return buildChatInstructions(this.systemContext);
  }

  protected resolveTier(
    cfg?: MastraModelConfig,
  ): Promise<Exclude<LanguageModel, string> | undefined> {
    if (!cfg) return Promise.resolve(undefined);
    return resolveAiSdkModel(this.mastra, cfg);
  }

  /**
   * Resolve every binding workflow steps may read from RequestContext. The set
   * is fixed + bounded (least-privilege). Each lookup is `{optional: true}` so
   * deployments without the DbQuery / Visualizer sub-components still get a
   * runnable RequestContext.
   */
  protected async resolveShape(args: {
    resourceId: string;
    eventWriter: (event: LLMStreamEvent) => void;
  }): Promise<MastraRcShape> {
    const opt = {optional: true} as const;
    const [
      dbConnector,
      authUser,
      datasetStore,
      templateStore,
      schemaStore,
      schemaHelper,
      templateHelper,
      dataSetHelper,
      permissionHelper,
      queryCache,
      templateCache,
      config,
      chatLlm,
      cheapLlm,
      smartLlm,
      smartNonThinkingLlm,
    ] = await Promise.all([
      this.lb4Ctx.get<IDbConnector>(DbQueryAIExtensionBindings.Connector, opt),
      this.lb4Ctx.get<IAuthUserWithPermissions>(
        AuthenticationBindings.CURRENT_USER,
        opt,
      ),
      this.lb4Ctx.get<IDataSetStore>(
        DbQueryAIExtensionBindings.DatasetStore,
        opt,
      ),
      this.lb4Ctx.get<IQueryTemplateStore>(
        DbQueryAIExtensionBindings.TemplateStore,
        opt,
      ),
      this.lb4Ctx.get<SchemaStore>('services.SchemaStore', opt),
      this.lb4Ctx.get<DbSchemaHelperService>(
        'services.DbSchemaHelperService',
        opt,
      ),
      this.lb4Ctx.get<TemplateHelper>('services.TemplateHelper', opt),
      this.lb4Ctx.get<DataSetHelper>('services.DataSetHelper', opt),
      this.lb4Ctx.get<PermissionHelper>('services.PermissionHelper', opt),
      this.lb4Ctx.get<MastraRcShape['queryCache']>(
        DbQueryAIExtensionBindings.QueryCache,
        opt,
      ),
      this.lb4Ctx.get<MastraRcShape['templateCache']>(
        DbQueryAIExtensionBindings.TemplateCache,
        opt,
      ),
      this.lb4Ctx.get<DbQueryConfig>(DbQueryAIExtensionBindings.Config, opt),
      this.resolveTier(this.chatLlm),
      this.resolveTier(this.cheapLlm),
      this.resolveTier(this.smartLlm),
      this.resolveTier(this.smartNonThinkingLlm),
    ]);
    const visBindings = this.lb4Ctx.findByTag({[VISUALIZATION_KEY]: true});
    const visualizers = await Promise.all(
      visBindings.map(b => this.lb4Ctx.get<IVisualizer>(b.key)),
    );
    return {
      resourceId: args.resourceId,
      eventWriter: args.eventWriter,
      chatLlm,
      cheapLlm,
      smartLlm,
      smartNonThinkingLlm,
      // Per-request chat-agent config consumed by the registered chatAgent's
      // dynamic params. model falls back to MASTRA_DEFAULT_CHAT_MODEL inside the
      // agent when chatLlm is unbound — fail-closed is enforced at Provider boot.
      agentModel: this.chatLlm,
      agentTools: this.buildToolMap(),
      agentInstructions: this.buildInstructions(),
      dbConnector,
      authUser,
      datasetStore,
      config,
      templateStore,
      schemaStore,
      schemaHelper,
      templateHelper,
      dataSetHelper,
      permissionHelper,
      queryCache,
      templateCache,
      visualizers,
      // Per-request step resolver. Closes over the request-scoped LB4 context so
      // a committed step shell resolves its `@graphNode(key)` implementation with
      // request-scoped collaborators. Mirrors BaseGraph._getNodeFn.
      resolveNode: (key: string) => resolveNodeFromContext(this.lb4Ctx, key),
    };
  }

  /**
   * Bind the per-request resolved model tiers into the request context so step
   * classes can `@inject(AiIntegrationBindings.CheapModel)` etc. Only binds
   * tiers that resolved to a model; unbound tiers stay absent so a step's
   * optional injection is undefined and it falls back to the chat model.
   */
  protected bindRuntimeModels(shape: MastraRcShape): void {
    const tiers: Array<[typeof AiIntegrationBindings.ChatModel, unknown]> = [
      [AiIntegrationBindings.ChatModel, shape.chatLlm],
      [AiIntegrationBindings.CheapModel, shape.cheapLlm],
      [AiIntegrationBindings.SmartModel, shape.smartLlm],
      [AiIntegrationBindings.SmartNonThinkingModel, shape.smartNonThinkingLlm],
    ];
    for (const [key, model] of tiers) {
      if (model !== undefined) this.lb4Ctx.bind(key).to(model as never);
    }
  }

  protected populate(
    ctx: RequestContext<MastraRcShape>,
    values: MastraRcShape,
  ): void {
    for (const key of Object.keys(values) as Array<keyof MastraRcShape>) {
      const value = values[key];
      if (value !== undefined) {
        ctx.set(key, value);
      }
    }
  }
}
