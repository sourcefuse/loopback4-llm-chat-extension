import {service} from '@loopback/core';
import {Filter, FilterExcludingWhere} from '@loopback/repository';
import {
  del,
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  patch,
  post,
  requestBody,
} from '@loopback/rest';
import {
  CONTENT_TYPE,
  OPERATION_SECURITY_SPEC,
  STATUS_CODE,
} from '@sourceloop/core';
import {authenticate, STRATEGY} from 'loopback4-authentication';
import {authorize} from 'loopback4-authorization';
import {PermissionKey} from '../../../permissions';
import {DataSet} from '../models';
import {DataSetHelper} from '../services';
import {IDataSet} from '../types';
import {DatasetUpdateDTO} from '../models/dataset-update-dto.model';
import {DatasetActionType} from '../constant';

const DATASET_BY_ID_PATH = '/datasets/{id}';

export class DataSetController {
  constructor(
    @service(DataSetHelper)
    private readonly datasetHelper: DataSetHelper,
  ) {}

  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @authorize({permissions: [PermissionKey.ExecuteDataset]})
  @get('/datasets/{id}/execute', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Result of the dataset execution',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {
              type: 'array',
              items: getModelSchemaRef(DataSet),
            },
          },
        },
      },
    },
  })
  async execute(
    @param.path.string('id')
    datasetId: string,
    @param.query.number('limit', {optional: true})
    limit?: number,
    @param.query.number('offset', {optional: true})
    offset?: number,
  ) {
    return this.datasetHelper.getDataFromDataset(datasetId, limit, offset);
  }

  @authorize({permissions: [PermissionKey.ViewDataset]})
  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @get('/datasets', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.OK]: {
        description: 'List of all datasets',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {
              type: 'array',
              items: getModelSchemaRef(DataSet),
            },
          },
        },
      },
    },
  })
  async find(@param.filter(DataSet) filter?: Filter<IDataSet>) {
    return this.datasetHelper.find({
      ...filter,
      fields: [
        'id',
        'tenantId',
        'createdBy',
        'votes',
        'description',
        'createdOn',
        'modifiedOn',
      ],
    });
  }

  @authorize({permissions: [PermissionKey.ViewDataset]})
  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @get(DATASET_BY_ID_PATH, {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Dataset with the given ID',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: getModelSchemaRef(DataSet),
          },
        },
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(DataSet, {exclude: ['where']})
    filter?: FilterExcludingWhere<IDataSet>,
  ) {
    const [dataset] = await this.datasetHelper.find({
      where: {id},
      ...filter,
      fields: [
        'id',
        'tenantId',
        'createdBy',
        'votes',
        'description',
        'createdOn',
        'modifiedOn',
      ],
    } as Filter<IDataSet>);
    const action = await this.datasetHelper.getLikes(id);
    if (!dataset) {
      throw new HttpErrors.NotFound(`Dataset with id ${id} not found`);
    }
    return {
      ...dataset,
      liked:
        action?.action === DatasetActionType.Liked
          ? true
          : action?.action === DatasetActionType.Disliked
            ? false
            : null,
      feedback: action?.comment ?? undefined,
    };
  }

  @authorize({permissions: [PermissionKey.UpdateDataset]})
  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @patch(DATASET_BY_ID_PATH, {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.NO_CONTENT]: {
        description: 'Update dataset with the given ID',
        content: {
          [CONTENT_TYPE.JSON]: {},
        },
      },
    },
  })
  async updateDatasetValidity(
    @param.path.string('id', {required: true}) id: string,
    @requestBody({
      required: true,
      content: {
        [CONTENT_TYPE.JSON]: {
          schema: getModelSchemaRef(DatasetUpdateDTO),
        },
      },
    })
    body: DatasetUpdateDTO,
  ) {
    await this.datasetHelper.updateById(id, body);
  }

  @authorize({permissions: [PermissionKey.DeleteDataset]})
  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @del(DATASET_BY_ID_PATH, {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.NO_CONTENT]: {
        description: 'Dataset deleted',
      },
    },
  })
  async deleteById(@param.path.string('id') id: string) {
    await this.datasetHelper.deleteById(id);
  }

  @authorize({permissions: [PermissionKey.DeleteDataset]})
  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @post('/datasets/delete', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Number of datasets deleted',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {
              type: 'object',
              properties: {count: {type: 'number'}},
            },
          },
        },
      },
    },
  })
  async deleteMany(
    @requestBody({
      required: true,
      content: {
        [CONTENT_TYPE.JSON]: {
          schema: {
            type: 'object',
            required: ['ids'],
            properties: {
              ids: {type: 'array', items: {type: 'string'}},
            },
          },
        },
      },
    })
    body: {
      ids: string[];
    },
  ): Promise<{count: number}> {
    const count = await this.datasetHelper.deleteMany(body.ids ?? []);
    return {count};
  }
}
