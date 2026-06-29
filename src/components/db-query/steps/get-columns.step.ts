import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {InternalBindings} from '../../../runtime/internal-bindings';
import {DbQueryAIExtensionBindings} from '../keys';
import type {SchemaStore} from '../services/schema.store';
import type {DbQueryConfig, IDbConnector} from '../types';
import {
  emitToolStatus,
  getSchemaForPrompt,
  getTablesWithColumns,
  logStepDetail,
  pickRelevantTables,
} from './_helpers';
import {STEP_GET_COLUMNS} from './constants';

/**
 * Narrow tables to those relevant to the query + answerability gate (the
 * Mastra-named successor of the LangGraph GetColumnsNode). DI-resolved `@step`
 * class with constructor-injected collaborators.
 */
@step(STEP_GET_COLUMNS)
export class GetColumnsStep implements IWorkflowStep {
  constructor(
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject(DbQueryAIExtensionBindings.Connector, {optional: true})
    private readonly dbConnector?: IDbConnector,
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    private readonly config?: DbQueryConfig,
    @inject(InternalBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(InternalBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
  ) {}

  async execute({inputData, requestContext, tracingContext}: WorkflowStepCtx) {
    emitToolStatus(
      requestContext,
      STEP_GET_COLUMNS,
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

    const tablesWithColumns = getTablesWithColumns(this.schemaStore, tables);
    const picked = await pickRelevantTables({
      chatLlm,
      tracing: tracingContext,
      prompt,
      tablesWithColumns,
      schema: getSchemaForPrompt(this.schemaStore, this.dbConnector, tables),
      upstreamTables: tables,
    });

    // Early gate (restores v2 get-tables' fast-fail): an unanswerable
    // question stops here instead of falling through to the expensive
    // SQL-generation/validation loop.
    if (picked.kind === 'unanswerable') {
      logStepDetail(STEP_GET_COLUMNS, `Unanswerable: ${picked.reason}`);
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
    logStepDetail(STEP_GET_COLUMNS, `Selected tables: ${tablesOut.join(', ')}`);
    return {
      kind: 'continue' as const,
      prompt,
      tables: tablesOut,
      templateId,
      ...sample,
    };
  }
}
