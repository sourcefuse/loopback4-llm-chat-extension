import {inject} from '@loopback/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DbSchemaHelperService, TemplateHelper} from '../services';
import type {SchemaStore} from '../services/schema.store';
import type {
  IDataSetStore,
  IQueryTemplateStore,
  TemplateBranchOut,
} from '../types';
import {computeSchemaHash, idToString, resolvePersistDeps} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';

/**
 * Persist a dataset resolved from a matched template (successor of the
 * LangGraph SaveDatasetFromTemplate node). DI-resolved `@step` class.
 */
@graphNode(DbQueryNodes.SaveFromTemplate)
export class SaveDatasetFromTemplateNode implements IGraphNode<
  unknown,
  TemplateBranchOut
> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
    @inject(AuthenticationBindings.CURRENT_USER, {optional: true})
    private readonly authUser?: IAuthUserWithPermissions,
    @inject(DbQueryAIExtensionBindings.TemplateStore, {optional: true})
    private readonly templateStore?: IQueryTemplateStore,
    @inject('services.TemplateHelper', {optional: true})
    private readonly templateHelper?: TemplateHelper,
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject('services.DbSchemaHelperService', {optional: true})
    private readonly schemaHelper?: DbSchemaHelperService,
  ) {}

  async execute({inputData}: GraphNodeCtx): Promise<TemplateBranchOut> {
    const data = inputData as {
      templateId?: string;
      prompt?: string;
      tables?: string[];
    };
    const fallback = {kind: 'template' as const, datasetId: '', sql: ''};
    if (!data.templateId || !data.prompt) return fallback;

    const persist = resolvePersistDeps(this.datasetStore, this.authUser);
    if (!persist) return fallback;

    // Fail to fallback when no TemplateHelper is bound (partial config).
    const resolved = await this.templateHelper?.resolveById({
      templateStore: this.templateStore,
      schemaStore: this.schemaStore,
      templateId: data.templateId,
      prompt: data.prompt,
    });
    if (!resolved) return fallback;

    const {schemaHash} = computeSchemaHash(this.schemaHelper, this.schemaStore);

    const dataset = await persist.store.create({
      tenantId: persist.user.tenantId,
      query: resolved.sql,
      description: resolved.description ?? '',
      prompt: data.prompt,
      // Union the template's authoritative tables with the get-tables guess.
      // The read-time ACL (DataSetHelper.getDataFromDataset) gates on
      // dataset.tables; persisting only the guess could omit a table the
      // template SQL reads, letting an unauthorized user through. The union
      // keeps the gate covering every table the query can touch.
      tables: [...new Set([...resolved.tables, ...(data.tables ?? [])])],
      schemaHash,
      votes: 0,
    });

    return {
      kind: 'template' as const,
      datasetId: idToString(dataset.id),
      sql: resolved.sql,
    };
  }
}
