import {inject, service} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DbSchemaHelperService} from '../services';
import type {SchemaStore} from '../services/schema.store';
import type {DbQueryConfig} from '../types';
import {DbQueryNodes} from '../nodes.enum';
import {
  CHECKLIST_MIN_TABLES,
  type checklistStateSchema,
} from '../checklist.shared';
import {ChecklistHelper} from '../services/checklist-helper.service';
import type {z} from 'zod';

type ChecklistState = z.infer<typeof checklistStateSchema>;

/**
 * Second checklist pass (the Mastra-named successor of the LangGraph
 * VerifyChecklistNode). Re-evaluates GlobalContext + per-table domain rules
 * with the smart tier and merges them in; self-gates and is otherwise a
 * pass-through. DI-resolved `@step` class.
 */
@graphNode(DbQueryNodes.VerifyChecklist)
export class VerifyChecklistNode implements IGraphNode<
  ChecklistState,
  ChecklistState
> {
  constructor(
    // ponytail: optional + default instance keeps the step zero-arg
    // constructible (the step registry's `new () =>` contract); DI injects the
    // bound (rebindable) service when the component is mounted.
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
    @inject(AiIntegrationBindings.SmartModel, {optional: true})
    private readonly smartModel?: LanguageModel,
    @inject(AiIntegrationBindings.SmartNonThinkingModel, {optional: true})
    private readonly smartNonThinkingModel?: LanguageModel,
  ) {}

  async execute({
    inputData,
    tracingContext,
  }: GraphNodeCtx<ChecklistState>): Promise<ChecklistState> {
    const data = inputData;
    const config = this.config;
    const disabled = config?.nodes?.verifyChecklistNode?.enabled === false;

    if (
      disabled ||
      data.cached === true ||
      data.unanswerable === true ||
      data.tables.length <= CHECKLIST_MIN_TABLES
    ) {
      return data;
    }

    // Prefer the non-thinking smart model (thinking chunks pollute the
    // index-list parse), falling back to the smart tier (v2
    // `smartNonThinkingLlm ?? smartLlm`).
    const verifyLlm =
      this.smartNonThinkingModel ?? this.smartModel ?? this.chatModel;

    const verifiedRules = await this.checklistHelper.selectDomainRules({
      globalContext: this.globalContext,
      schemaStore: this.schemaStore,
      schemaHelper: this.schemaHelper,
      llm: verifyLlm,
      prompt: data.prompt,
      tables: data.tables,
      label: 'verify-checklist',
      evaluation: config?.nodes?.verifyChecklistNode?.evaluation ?? false,
      tracing: tracingContext,
    });

    if (verifiedRules.length === 0) return data;

    return {
      ...data,
      checklist: this.checklistHelper.mergeChecklist(
        data.checklist,
        verifiedRules,
      ),
    };
  }
}
