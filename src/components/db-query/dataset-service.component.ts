import {
  Binding,
  BindingScope,
  Component,
  ControllerClass,
  CoreBindings,
  inject,
} from '@loopback/core';
import {
  AnyObject,
  Class,
  Entity,
  Model,
  Repository,
} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {DataSetController} from './controller';
import {DbQueryAIExtensionBindings} from './keys';
import {DataSet, DatasetAction} from './models';
import {DatasetActionRepository, DataSetRepository} from './repositories';

export class DatasetServiceComponent implements Component {
  bindings: Binding<AnyObject>[] | undefined;
  models: Class<Model>[] | undefined;
  controllers: ControllerClass[] | undefined;
  repositories: Class<Repository<Entity>>[] | undefined;
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly application: RestApplication,
  ) {
    this.application
      .bind(DbQueryAIExtensionBindings.DatasetStore)
      .toAlias(`repositories.${DataSetRepository.name}`)
      .inScope(BindingScope.TRANSIENT);

    this.models = [DataSet, DatasetAction];
    this.controllers = [DataSetController];
    this.repositories = [DataSetRepository, DatasetActionRepository];
  }
}
