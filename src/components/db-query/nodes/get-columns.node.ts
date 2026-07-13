import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {SchemaStore} from '../services/schema.store';
import type {DbQueryConfig, IDbConnector} from '../types';
import {emitToolStatus, logStepDetail, pickRelevantTables} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';

/**
 * Narrow tables to those relevant to the query + answerability gate (the
 * Mastra-named successor of the LangGraph GetColumnsNode). DI-resolved `@step`
 * class with constructor-injected collaborators.
 */
@graphNode(DbQueryNodes.GetColumns)
export class GetColumnsNode implements IGraphNode {
  constructor(
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject(DbQueryAIExtensionBindings.Connector, {optional: true})
    private readonly dbConnector?: IDbConnector,
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    private readonly config?: DbQueryConfig,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
  ) {}

  /**
   * Select the query-relevant tables + answerability gate. Overridable seam
   * restoring the v2 `GetTablesNode` LLM prompt/parse/unanswerable logic (which
   * the thin rewrite moved into the module-level `pickRelevantTables`): a host
   * can `extends GetColumnsNode` and override this to change the selection
   * prompt, parsing, or unanswerable policy, then rebind under
   * `@graphNode(DbQueryNodes.GetColumns)`. Delegates to the shared helper.
   */
  protected selectRelevantTables(
    args: Parameters<typeof pickRelevantTables>[0],
  ): ReturnType<typeof pickRelevantTables> {
    return pickRelevantTables(args);
  }

  async execute({inputData, requestContext, tracingContext}: GraphNodeCtx) {
    emitToolStatus(
      requestContext,
      DbQueryNodes.GetColumns,
      'Extracting relevant columns from the schema',
    );

    const data = inputData as {
      prompt?: string;
      tables?: string[];
      templateId?: string;
      sampleSql?: string;
      samplePrompt?: string;
    };
    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const templateId = data.templateId;
    const sample = {sampleSql: data.sampleSql, samplePrompt: data.samplePrompt};

    const chatLlm = this.cheapModel ?? this.chatModel;
    if (!chatLlm || tables.length === 0) {
      return {kind: 'continue' as const, prompt, tables, templateId, ...sample};
    }

    const tablesWithColumns = this.schemaStore?.tablesWithColumns(tables) ?? {};
    const picked = await this.selectRelevantTables({
      chatLlm,
      tracing: tracingContext,
      prompt,
      tablesWithColumns,
      schema: this.schemaStore?.schemaForPrompt(this.dbConnector, tables),
      upstreamTables: tables,
    });

    // Early gate (restores v2 get-tables' fast-fail): an unanswerable
    // question stops here instead of falling through to the expensive
    // SQL-generation/validation loop.
    if (picked.kind === 'unanswerable') {
      logStepDetail(DbQueryNodes.GetColumns, `Unanswerable: ${picked.reason}`);
      return {
        kind: 'continue' as const,
        prompt,
        tables: [],
        templateId,
        unanswerable: true,
        replyToUser: picked.reason,
      };
    }

    // Apply the LLM-picked subset ONLY when `columnSelection` is enabled.
    // With it off (the default), keep ALL upstream tables so a lookup table the
    // picker might omit (e.g. `exchange_rates`, needed for currency conversion)
    // is never dropped before SQL generation — dropping it silently produces
    // wrong, unconverted results on wide schemas. `true` narrows the schema to
    // keep the SQL-gen prompt small on very wide schemas (see
    // `DbQueryConfig.columnSelection`). `unknown` (no LLM / empty schema /
    // parse error) always keeps the full upstream set.
    const columnSelection = this.config?.columnSelection;
    const tablesOut =
      columnSelection && picked.kind === 'tables' ? picked.tables : tables;
    logStepDetail(
      DbQueryNodes.GetColumns,
      `Selected tables: ${tablesOut.join(', ')}`,
    );
    return {
      kind: 'continue' as const,
      prompt,
      tables: tablesOut,
      templateId,
      ...sample,
    };
  }
}
