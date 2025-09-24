import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {createHash} from 'crypto';
import {AuthenticationBindings} from 'loopback4-authentication';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, ToolStatus} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbQueryState} from '../state';
import {DatabaseSchema, DbQueryConfig, IDataSetStore} from '../types';
import {DEFAULT_MAX_READ_ROWS_FOR_AI} from '../constant';
import {AnyObject} from '@loopback/repository';

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
  ) {}

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
      throw new HttpErrors.InternalServerError();
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

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Dataset saved with id ${dataset.id}`,
    });

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: ToolStatus.Completed,
        data: {
          datasetId: dataset.id,
        },
      },
    });

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
