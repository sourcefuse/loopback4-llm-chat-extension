import {inject, service} from '@loopback/core';
import {
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  post,
  requestBody,
} from '@loopback/rest';
import {BaseRetriever} from '@langchain/core/retrievers';
import {
  CONTENT_TYPE,
  IAuthUserWithPermissions,
  OPERATION_SECURITY_SPEC,
  STATUS_CODE,
} from '@sourceloop/core';
import {createHash} from 'node:crypto';
import {
  authenticate,
  STRATEGY,
  AuthenticationBindings,
} from 'loopback4-authentication';
import {authorize} from 'loopback4-authorization';
import {VectorStore} from '@langchain/core/vectorstores';
import {AiIntegrationBindings} from '../../../keys';
import {PermissionKey} from '../../../permissions';
import {QueryTemplateDTO, TemplatePlaceholderDTO} from '../models';
import {
  DbQueryStoredTypes,
  IQueryTemplateStore,
  QueryTemplateMetadata,
} from '../types';
import {DbQueryAIExtensionBindings} from '../keys';
import {SchemaStore} from '../services/schema.store';

export class TemplateController {
  constructor(
    @inject(AiIntegrationBindings.VectorStore)
    private readonly vectorStore: VectorStore,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
    @service(SchemaStore)
    private readonly schemaStore: SchemaStore,
    @inject(DbQueryAIExtensionBindings.TemplateCache)
    private readonly templateRetriever: BaseRetriever<QueryTemplateMetadata>,
    @inject(DbQueryAIExtensionBindings.TemplateStore, {optional: true})
    private readonly templateStore: IQueryTemplateStore | undefined,
  ) {}

  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @authorize({permissions: [PermissionKey.CreateTemplate]})
  @post('/templates', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Template created successfully',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {
              type: 'object',
              properties: {
                id: {type: 'string'},
              },
            },
          },
        },
      },
    },
  })
  async create(
    @requestBody({
      required: true,
      content: {
        [CONTENT_TYPE.JSON]: {
          schema: getModelSchemaRef(QueryTemplateDTO),
        },
      },
    })
    body: QueryTemplateDTO,
  ) {
    const tenantId = this.user.tenantId;
    if (!tenantId) {
      throw new HttpErrors.BadRequest('User does not have a tenantId');
    }

    this._validatePlaceholders(body.template, body.placeholders);

    const schema = this.schemaStore.filteredSchema(body.tables);
    const schemaHash = this._hashSchema(schema, body.tables);
    const templateId = createHash('sha256')
      .update(`${tenantId}:${body.template}:${body.prompt}`)
      .digest('hex')
      .slice(0, 16);

    await this.vectorStore.addDocuments([
      {
        pageContent: body.prompt,
        metadata: {
          templateId,
          template: body.template,
          type: DbQueryStoredTypes.Template,
          tenantId,
          description: body.description,
          votes: 0,
          placeholders: JSON.stringify(body.placeholders),
          tables: JSON.stringify(body.tables),
          schemaHash,
        },
      },
    ]);

    return {id: templateId};
  }

  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @authorize({permissions: [PermissionKey.ViewTemplate]})
  @get('/templates', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.OK]: {
        description: 'List of query templates',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: {type: 'string'},
                  prompt: {type: 'string'},
                  description: {type: 'string'},
                  template: {type: 'string'},
                  tables: {type: 'array', items: {type: 'string'}},
                  placeholders: {type: 'array', items: {type: 'object'}},
                  schemaHash: {type: 'string'},
                  votes: {type: 'number'},
                },
              },
            },
          },
        },
      },
    },
  })
  async find(
    @param.query.string('query', {
      description:
        'Optional search query to rank templates by similarity. If omitted, returns all templates.',
    })
    query?: string,
  ) {
    // Similarity-ranked search when query is provided
    if (query) {
      const docs = await this.templateRetriever.invoke(query);
      return docs.map(doc => ({
        id: doc.metadata.templateId,
        prompt: doc.pageContent,
        description: doc.metadata.description,
        template: doc.metadata.template,
        tables: JSON.parse(doc.metadata.tables),
        placeholders: JSON.parse(doc.metadata.placeholders),
        schemaHash: doc.metadata.schemaHash,
        votes: doc.metadata.votes,
      }));
    }

    // List all templates when no query — use store if available
    if (!this.templateStore) {
      throw new HttpErrors.BadRequest(
        'A query parameter is required when no template store is configured',
      );
    }
    const tenantId = this.user.tenantId;
    const templates = await this.templateStore.find({
      where: {tenantId},
    });
    return templates;
  }

  private _validatePlaceholders(
    template: string,
    placeholders: TemplatePlaceholderDTO[],
  ) {
    const markerPattern = /\{\{(\w+)\}\}/g;
    const markersInTemplate = new Set<string>();
    let match;
    while ((match = markerPattern.exec(template)) !== null) {
      markersInTemplate.add(match[1]);
    }

    const placeholderNames = new Set(placeholders.map(p => p.name));

    // Every marker in the template must have a corresponding placeholder
    this._validatePlaceholderMarker(markersInTemplate, placeholderNames);

    // Every placeholder must appear in the template
    this._validatePlaceholderPresenceInTemplate(
      markersInTemplate,
      placeholderNames,
    );

    // template_ref placeholders must have a templateId
    this._validateTemplateRefId(placeholders);
  }

  private _validatePlaceholderMarker(
    markersInTemplate: Set<string>,
    placeholderNames: Set<string>,
  ) {
    for (const marker of markersInTemplate) {
      if (!placeholderNames.has(marker)) {
        throw new HttpErrors.BadRequest(
          `Template contains placeholder {{${marker}}} but no matching placeholder definition was provided`,
        );
      }
    }
  }

  private _validatePlaceholderPresenceInTemplate(
    markersInTemplate: Set<string>,
    placeholderNames: Set<string>,
  ) {
    for (const name of placeholderNames) {
      if (!markersInTemplate.has(name)) {
        throw new HttpErrors.BadRequest(
          `Placeholder "${name}" is defined but not used in the template`,
        );
      }
    }
  }

  private _validateTemplateRefId(placeholders: TemplatePlaceholderDTO[]) {
    for (const p of placeholders) {
      if (p.type === 'template_ref' && !p.templateId) {
        throw new HttpErrors.BadRequest(
          `Placeholder "${p.name}" is of type template_ref but has no templateId`,
        );
      }
    }
  }

  private _hashSchema(
    schema: {tables: Record<string, {columns: Record<string, {type: string}>}>},
    tables: string[],
  ): string {
    const hash = createHash('sha256');
    const sortedTables = [...tables].sort((a, b) => a.localeCompare(b));
    for (const table of sortedTables) {
      hash.update(table);
      const columns = schema.tables[table]?.columns ?? {};
      Object.keys(columns)
        .sort((a, b) => a.localeCompare(b))
        .forEach(column => {
          hash.update(`${column}:${columns[column].type}`);
        });
    }
    return hash.digest('hex');
  }
}
