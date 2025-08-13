import {service} from '@loopback/core';
import {Filter, FilterExcludingWhere} from '@loopback/repository';
import {
  get,
  getModelSchemaRef,
  HttpErrors,
  param,
  patch,
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
      fields: ['id', 'tenantId', 'createdBy', 'valid', 'description'],
    });
  }

  @authorize({permissions: [PermissionKey.ViewDataset]})
  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @get('/datasets/{id}', {
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
      fields: ['id', 'tenantId', 'createdBy', 'valid', 'description'],
    } as Filter<IDataSet>);
    if (!dataset) {
      throw new HttpErrors.NotFound(`Dataset with id ${id} not found`);
    }
    return dataset;
  }

  @authorize({permissions: [PermissionKey.UpdateDataset]})
  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @patch('/datasets/{id}', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.NO_CONTENT]: {
        description: 'Update dataset with the given ID',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: getModelSchemaRef(DataSet),
          },
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
          schema: {
            type: 'object',
            properties: {
              valid: {type: 'boolean'},
              feedback: {type: 'string'},
            },
            required: ['valid'],
          },
        },
      },
    })
    body: {valid: boolean; feedback?: string},
  ) {
    await this.datasetHelper.updateById(id, {
      valid: body.valid,
      feedback: body.feedback,
    });
  }
}
