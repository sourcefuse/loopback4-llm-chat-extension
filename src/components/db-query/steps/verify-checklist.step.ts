import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {InternalBindings} from '../../../runtime/internal-bindings';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DbSchemaHelperService} from '../services';
import type {SchemaStore} from '../services/schema.store';
import type {DbQueryConfig} from '../types';
import {STEP_VERIFY_CHECKLIST} from './constants';
import {
  CHECKLIST_MIN_TABLES,
  type checklistStateSchema,
  mergeChecklist,
  selectDomainRules,
} from './checklist.shared';
import type {z} from 'zod';

type ChecklistState = z.infer<typeof checklistStateSchema>;

/**
 * Second checklist pass (the Mastra-named successor of the LangGraph
 * VerifyChecklistNode). Re-evaluates GlobalContext + per-table domain rules
 * with the smart tier and merges them in; self-gates and is otherwise a
 * pass-through. DI-resolved `@step` class.
 */
@step(STEP_VERIFY_CHECKLIST)
export class VerifyChecklistStep implements IWorkflowStep<
  ChecklistState,
  ChecklistState
> {
  constructor(
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    private readonly config?: DbQueryConfig,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly globalContext: string[] = [],
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject('services.DbSchemaHelperService', {optional: true})
    private readonly schemaHelper?: DbSchemaHelperService,
    @inject(InternalBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(InternalBindings.SmartModel, {optional: true})
    private readonly smartModel?: LanguageModel,
    @inject(InternalBindings.SmartNonThinkingModel, {optional: true})
    private readonly smartNonThinkingModel?: LanguageModel,
  ) {}

  async execute({
    inputData,
    tracingContext,
  }: WorkflowStepCtx<ChecklistState>): Promise<ChecklistState> {
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

    const verifiedRules = await selectDomainRules({
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

    return {...data, checklist: mergeChecklist(data.checklist, verifiedRules)};
  }
}
