import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {tracedGenerateText} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';
import {ChangeType} from '../types';
import type {SqlLoopState} from './sql-generation.node';

/**
 * Classify the level of change requested against a similar/prior query (the
 * Mastra successor of the LangGraph `ClassifyChangeNode`). Runs before the
 * generation loop; its `changeType` feeds `SqlGenerationNode`'s cheap-vs-smart
 * tier choice (a `minor` change uses the cheap tier). No-op when there is no
 * `sampleSql` to compare against. DI-resolved, overridable.
 */
@graphNode(DbQueryNodes.ClassifyChange)
export class ClassifyChangeNode implements IGraphNode {
  constructor(
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
  ) {}

  async execute({inputData, tracingContext}: GraphNodeCtx) {
    const data = inputData as SqlLoopState;
    const llm = this.cheapModel ?? this.chatModel;
    if (!data.samplePrompt || !llm) return {...data};

    const prompt = `You are given the original description of a SQL query and a new description that includes user feedback. Classify the level of change required to transform the original into the new one.

Original: ${data.samplePrompt}
New: ${data.prompt ?? ''}

Return ONLY one of: minor, major, rewrite. No other text.`;
    try {
      const result = await tracedGenerateText({
        model: llm,
        prompt,
        tracing: tracingContext,
        label: 'classify-change',
        resultType: 'reasoning',
      });
      return {...data, changeType: this.parseChangeType(result.text)};
    } catch {
      return {...data};
    }
  }

  protected parseChangeType(response: string): ChangeType {
    const text = response.trim().toLowerCase();
    if (text.includes(ChangeType.Minor)) return ChangeType.Minor;
    if (text.includes(ChangeType.Rewrite)) return ChangeType.Rewrite;
    return ChangeType.Major;
  }
}
