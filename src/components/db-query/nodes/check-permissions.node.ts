import {inject} from '@loopback/context';
import {service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {
  IGraphNode,
  invokeModel,
  renderPrompt,
  RunnableConfig,
} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryNodes} from '../nodes.enum';
import {PermissionHelper} from '../services';
import {DbQueryState} from '../state';
import {Errors} from '../types';

@graphNode(DbQueryNodes.CheckPermissions)
export class CheckPermissionsNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider, // Replace with actual type if available

    @service(PermissionHelper)
    private readonly permissions: PermissionHelper,
  ) {}

  prompt = `You are an AI assistant that received the following request from the user -
  {prompt}

  But as this request requires access to the following tables -
  {tables}

  and user the does not have permissions for the following tables -
  {missingPermissions}

  You must return an error message that explains the user that they do not have permissions to access the required tables and cannot proceed with the request, and then asking him to give a new request.
  Do not give direct tables names or any technical details, use plain language to explain the error.
  Do not return any other text, comments, or explanations. Only return a simple error message with request for new prompt.
  `;

  async execute(
    state: DbQueryState,
    config: RunnableConfig,
  ): Promise<DbQueryState> {
    const missingPermissions = this.permissions.findMissingPermissions(
      this.getTableNames(state),
    );

    if (missingPermissions.length > 0) {
      const response = stripThinkingTokens(
        await invokeModel(
          this.llm,
          renderPrompt(this.prompt, {
            prompt: state.prompt,
            tables: this.getTableNames(state).join(', '),
            missingPermissions: missingPermissions.join(', '),
          }),
          {config},
        ),
      );

      return {
        ...state,
        status: Errors.PermissionError,
        replyToUser: response,
      };
    }
    return state;
  }

  private getTableNames(state: DbQueryState) {
    return Object.keys(state.schema.tables || {}).map(
      // exclude the schema name and dot from the table names
      table => table.toLowerCase().slice(table.indexOf('.') + 1),
    );
  }
}
