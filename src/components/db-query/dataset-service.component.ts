import {
  Binding,
  Component,
  ControllerClass,
  CoreBindings,
  Getter,
  inject,
} from '@loopback/core';
import {
  AnyObject,
  Class,
  Entity,
  juggler,
  Model,
  Repository,
} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {DataSetController} from './controller';
import {DatasetServiceBindings, DbQueryAIExtensionBindings} from './keys';
import {DataSet} from './models';
import {DataSetRepository as OriginDatasetRepository} from './repositories';
import {DatasetServiceConfig, IDataSetStore} from './types';

export class DatasetServiceComponent implements Component {
  bindings: Binding<AnyObject>[] | undefined;
  models: Class<Model>[] | undefined;
  controllers: ControllerClass[] | undefined;
  repositories: Class<Repository<Entity>>[] | undefined;
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly application: RestApplication,
    @inject(DatasetServiceBindings.Config, {optional: true})
    private datasetServiceConfig?: DatasetServiceConfig,
  ) {
    const dsName = this.datasetServiceConfig?.datasourceName ?? 'db';

    class DataSetRepository
      extends OriginDatasetRepository
      implements IDataSetStore
    {
      constructor(
        ds: juggler.DataSource,
        getCurrentUser: Getter<IAuthUserWithPermissions>,
        mainDs: juggler.DataSource,
      ) {
        super(ds, getCurrentUser, mainDs);
      }
    }
    inject(`datasources.${dsName}`)(DataSetRepository, undefined, 0);
    inject.getter(AuthenticationBindings.CURRENT_USER)(
      DataSetRepository,
      undefined,
      1,
    );
    inject('datasources.db')(DataSetRepository, undefined, 2);

    this.application
      .bind(`repositories.${DataSetRepository.name}`)
      .toClass(DataSetRepository);
    this.application
      .bind(DbQueryAIExtensionBindings.DatasetStore)
      .toAlias(`repositories.${DataSetRepository.name}`);

    this.models = [DataSet];
    this.controllers = [DataSetController];
  }
}
