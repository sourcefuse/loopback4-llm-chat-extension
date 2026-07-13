import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import {SqlValidatorService} from '../services/sql-validator.service';
import type {DbQueryConfig} from '../types';
import {emitToolStatus} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';
import type {SqlLoopState} from './sql-generation.node';

/**
 * Semantic validation (LLM judge vs the checklist) — the Mastra successor of
 * the LangGraph `SemanticValidatorNode`. Runs in parallel with the syntactic
 * validator + description generator. Delegates to the overridable
 * `SqlValidatorService.validateSemantic`; `useSmartLLM` config picks the tier.
 */
@graphNode(DbQueryNodes.SemanticValidator)
export class SemanticValidatorNode implements IGraphNode {
  constructor(
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    protected readonly config?: DbQueryConfig,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
    @inject(AiIntegrationBindings.SmartModel, {optional: true})
    protected readonly smartModel?: LanguageModel,
    @inject('services.SqlValidatorService', {optional: true})
    protected readonly sqlValidator: SqlValidatorService = new SqlValidatorService(),
  ) {}

  async execute({inputData, requestContext, tracingContext}: GraphNodeCtx) {
    const data = inputData as SqlLoopState;
    if (data.skip === true || data.genError != null || !data.sql) {
      return {semantic: {passed: true}};
    }
    emitToolStatus(
      requestContext,
      DbQueryNodes.SemanticValidator,
      "Verifying if the query fully satisfies the user's requirement",
    );
    const useSmart =
      this.config?.nodes?.semanticValidatorNode?.useSmartLLM ?? false;
    const llm = useSmart
      ? (this.smartModel ?? this.chatModel)
      : (this.cheapModel ?? this.chatModel);
    const verdict = await this.sqlValidator.validateSemantic({
      sql: data.sql,
      chatLlm: llm,
      prompt: data.prompt ?? '',
      checklist: data.checklist,
      tracing: tracingContext,
    });
    return {semantic: verdict};
  }
}
