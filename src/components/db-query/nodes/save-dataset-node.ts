import {inject} from '@loopback/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DbSchemaHelperService} from '../services';
import type {SchemaStore} from '../services/schema.store';
import type {IDataSetStore, SaveOut} from '../types';
import {computeSchemaHash, idToString, resolvePersistDeps} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';

/** Persist a generated dataset (successor of the LangGraph SaveDataset node). */
@graphNode(DbQueryNodes.SaveDataset)
export class SaveDataSetNode implements IGraphNode<unknown, SaveOut> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
    @inject(AuthenticationBindings.CURRENT_USER, {optional: true})
    private readonly authUser?: IAuthUserWithPermissions,
    @inject('services.DbSchemaHelperService', {optional: true})
    private readonly schemaHelper?: DbSchemaHelperService,
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
  ) {}

  async execute({inputData}: GraphNodeCtx): Promise<SaveOut> {
    const data = inputData as {
      sql?: string;
      description?: string;
      prompt?: string;
      tables?: string[];
      cached?: boolean;
      datasetId?: string;
    };

    if (data.cached && data.datasetId) {
      return {datasetId: idToString(data.datasetId), sql: data.sql ?? ''};
    }

    const fallback = {datasetId: '', sql: data.sql ?? ''};
    if (!data.sql) return fallback;

    const persist = resolvePersistDeps(this.datasetStore, this.authUser);
    if (!persist) return fallback;

    const {schemaHash, tablesFromSchema} = computeSchemaHash(
      this.schemaHelper,
      this.schemaStore,
    );
    const tableList = data.tables?.length ? data.tables : tablesFromSchema;

    const dataset = await persist.store.create({
      tenantId: persist.user.tenantId,
      query: data.sql,
      description: data.description ?? '',
      prompt: data.prompt ?? '',
      tables: tableList,
      schemaHash,
      votes: 0,
    });

    return {datasetId: idToString(dataset.id), sql: data.sql};
  }
}
