import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject, service} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {createHash} from 'crypto';
import {AuthenticationBindings} from 'loopback4-authentication';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, ToolStatus} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbQueryState} from '../state';
import {DatabaseSchema, DbQueryConfig, IDataSetStore} from '../types';
import {DEFAULT_MAX_READ_ROWS_FOR_AI} from '../constant';
import {AnyObject} from '@loopback/repository';
import {DbSchemaHelperService} from '../services';

@graphNode(DbQueryNodes.SaveDataset)
export class SaveDataSetNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly store: IDataSetStore,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
    @service(DbSchemaHelperService)
    private readonly dbSchemaHelper: DbSchemaHelperService,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks?: string[],
  ) {}

  prompt =
    PromptTemplate.fromTemplate(`You are an AI assitant that generates a short description of a query based on a given schema, providing a summary of the query's intent and user's demand in a way that is short but does not miss any importance detail.

  Here is the query that you need to describe - {query}

  And here is the schema that was used to generate the query -
  {schema}


  {checks}
  The output should be a valid description of the query that is easy to understand by the user in plain text, without any formatting`);

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    config.writer?.({
      type: LLMStreamEventType.Log,
      data: 'Dataset generated',
    });

    const tenantId = this.user.tenantId;
    if (!tenantId) {
      throw new HttpErrors.BadRequest(`User does not have a tenantId`);
    }
    if (!state.sql) {
      throw new HttpErrors.InternalServerError();
    }

    if (!state.description) {
      const chain = RunnableSequence.from([this.prompt, this.llm]);

      const output = await chain.invoke({
        checks: [
          'You must keep these additional details in consideration while describing the query -',
          ...(this.checks ?? []),
        ].join('\n'),
        query: state.sql,
        schema: this.dbSchemaHelper.asString(state.schema),
      });

      state.description = stripThinkingTokens(output);
    }

    const dataset = await this.store.create({
      query: state.sql,
      tenantId,
      description: state.description,
      prompt: state.prompt,
      tables: this._getTableList(state.schema),
      schemaHash: this._hashSchema(state.schema),
      votes: 0,
    });

    if (!state.directCall) {
      config.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {
          status: ToolStatus.Completed,
          data: {
            datasetId: dataset.id,
          },
        },
      });
    }

    let result: undefined | AnyObject[] = undefined;
    if (this.config.readAccessForAI && dataset.id) {
      result = await this.store.getData(
        dataset.id,
        this.config.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI,
      );
    }

    return {
      ...state,
      datasetId: dataset.id,
      replyToUser: state.description,
      done: true,
      resultArray: result,
    };
  }

  private _hashSchema(schema: DatabaseSchema): string {
    const hash = createHash('sha256');
    const tableList = this._getTableList(schema).sort((a, b) =>
      a.localeCompare(b),
    );
    tableList.forEach(table => {
      hash.update(table);
      const columns = schema.tables[table]?.columns || {};
      Object.keys(columns)
        .sort((a, b) => a.localeCompare(b))
        .forEach(column => {
          hash.update(`${column}:${columns[column].type}`);
        });
    });
    return hash.digest('hex');
  }

  private _getTableList(schema: DatabaseSchema): string[] {
    if (!schema?.tables) {
      return [];
    }
    return Object.keys(schema.tables);
  }
}
