import {inject, service} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DbSchemaHelperService} from '../services';
import type {SchemaStore} from '../services/schema.store';
import {ChecklistHelper} from '../services/checklist-helper.service';
import type {DbQueryConfig, IDataSetStore, LoadIn} from '../types';
import {CHECKLIST_MIN_TABLES} from '../checklist.shared';
import {DbQueryNodes} from '../nodes.enum';

/** Load the dataset being improved (successor of the LangGraph load step). */
@graphNode(DbQueryNodes.LoadExisting)
export class LoadExistingNode implements IGraphNode<LoadIn> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
    // Checklist collaborators — the improve path generates a checklist here (as
    // the generate path does in generate-checklist) so fix-query's semantic
    // validation actually runs; without it `checklist:''` makes validateSemantic
    // auto-pass and disliked/improved queries get syntactic validation only.
    @service(ChecklistHelper, {optional: true})
    private readonly checklistHelper: ChecklistHelper = new ChecklistHelper(),
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    private readonly config?: DbQueryConfig,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly globalContext: string[] = [],
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject('services.DbSchemaHelperService', {optional: true})
    private readonly schemaHelper?: DbSchemaHelperService,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
  ) {}

  async execute({inputData, tracingContext}: GraphNodeCtx<LoadIn>) {
    const base = {
      datasetId: inputData.datasetId,
      prompt: inputData.prompt,
      originalPrompt: undefined as string | undefined,
      originalSql: undefined as string | undefined,
      tables: [] as string[],
      checklist: '',
      attempts: 0,
      loadError: false,
    };

    const store = this.datasetStore;
    if (!store) return {...base, loadError: true};

    try {
      const dataset = await store.findById(inputData.datasetId);
      const tables = dataset.tables ?? [];
      const prompt = `${dataset.prompt}\n also consider following feedback given by user -\n ${inputData.prompt}\n`;
      const checklist = await this.buildChecklist(
        prompt,
        tables,
        tracingContext,
      );
      return {
        ...base,
        originalPrompt: dataset.prompt,
        originalSql: dataset.query,
        tables,
        prompt,
        checklist,
      };
    } catch {
      return {...base, loadError: true};
    }
  }

  /**
   * Domain-rule checklist for the improved query (mirrors generate-checklist).
   * Gated exactly like the generate path: skipped when disabled or on <=2 tables
   * where the planning value doesn't pay for the extra round-trip.
   */
  private async buildChecklist(
    prompt: string,
    tables: string[],
    tracing?: GraphNodeCtx['tracingContext'],
  ): Promise<string> {
    const cheap = this.cheapModel ?? this.chatModel;
    const disabled =
      this.config?.nodes?.generateChecklistNode?.enabled === false;
    if (disabled || tables.length <= CHECKLIST_MIN_TABLES || !cheap) return '';
    const domainRules = await this.checklistHelper.selectDomainRules({
      globalContext: this.globalContext,
      schemaStore: this.schemaStore,
      schemaHelper: this.schemaHelper,
      llm: cheap,
      prompt,
      tables,
      label: 'improve-checklist-rules',
      parallelism: this.config?.nodes?.generateChecklistNode?.parallelism ?? 1,
      tracing,
    });
    return this.checklistHelper.mergeChecklist('', domainRules);
  }
}
