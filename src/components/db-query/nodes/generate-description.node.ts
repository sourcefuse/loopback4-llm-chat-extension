import {inject, service} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import {SqlGenerationHelper} from '../services/sql-generation.service';
import type {DbQueryConfig} from '../types';
import {DbQueryNodes} from '../nodes.enum';
import type {SqlLoopState} from './sql-generation.node';

/**
 * Stream a plain-english description of the generated SQL — the Mastra
 * successor of the LangGraph `GenerateDescriptionNode`. Runs in parallel with
 * the validators (v2 PreValidation fan-out); its tokens stream to the client as
 * `thinkingToken` events. Delegates to the overridable `SqlGenerationHelper`.
 * Disabled via `config.nodes.sqlGenerationNode.generateDescription = false`.
 */
@graphNode(DbQueryNodes.GenerateDescription)
export class GenerateDescriptionNode implements IGraphNode {
  constructor(
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    protected readonly config?: DbQueryConfig,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    protected readonly globalContext: string[] = [],
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
    @service(SqlGenerationHelper, {optional: true})
    protected readonly sqlGen: SqlGenerationHelper = new SqlGenerationHelper(),
  ) {}

  async execute({inputData, requestContext, tracingContext}: GraphNodeCtx) {
    const data = inputData as SqlLoopState;
    const enabled =
      this.config?.nodes?.sqlGenerationNode?.generateDescription !== false;
    if (data.skip === true || data.genError != null || !data.sql || !enabled) {
      return {description: ''};
    }
    const description = await this.sqlGen.streamDescription({
      model: this.cheapModel ?? this.chatModel,
      prompt: data.prompt ?? '',
      sql: data.sql,
      checks: this.globalContext,
      rc: requestContext,
      tracing: tracingContext,
    });
    return {description};
  }
}
