import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {PermissionHelper} from '../services/permission-helper.service';
import {tracedGenerateText} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';
import {Errors} from '../types';

/**
 * Permission gate (the Mastra successor of the LangGraph `CheckPermissionsNode`).
 * If the user lacks read permission for any required table it returns a
 * plain-language error asking them to rephrase. Preserved as a DI-resolved,
 * overridable `@graphNode` seam; like v2 it is available for a host that wires a
 * pre-generation permission gate (the default generate graph filters
 * inaccessible tables via `PermissionHelper` instead). Delegates to the
 * overridable `PermissionHelper`.
 */
@graphNode(DbQueryNodes.CheckPermissions)
export class CheckPermissionsNode implements IGraphNode {
  constructor(
    @inject('services.PermissionHelper', {optional: true})
    protected readonly permissions?: PermissionHelper,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
  ) {}

  async execute({inputData, tracingContext}: GraphNodeCtx) {
    const data = inputData as {prompt?: string; tables?: string[]};
    const tables = this.tableNames(data.tables ?? []);
    const missing = this.permissions?.findMissingPermissions(tables) ?? [];
    const llm = this.cheapModel ?? this.chatModel;
    if (missing.length === 0 || !llm) return {...data};

    const prompt = `The user asked: ${data.prompt ?? ''}
This needs data they are not permitted to access. In plain, non-technical language, tell them they don't have access to some of the requested data and ask them to try a different request. Do not name tables or technical details. Return only the message.`;
    try {
      const result = await tracedGenerateText({
        model: llm,
        prompt,
        tracing: tracingContext,
        label: 'check-permissions',
        resultType: 'response_generation',
      });
      return {
        ...data,
        status: Errors.PermissionError,
        replyToUser: result.text,
      };
    } catch {
      return {
        ...data,
        status: Errors.PermissionError,
        replyToUser:
          'You do not have access to some of the requested data. Please try a different request.',
      };
    }
  }

  protected tableNames(tables: string[]): string[] {
    return tables.map(t => t.toLowerCase().slice(t.indexOf('.') + 1));
  }
}
