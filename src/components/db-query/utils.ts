import {Entity} from '@loopback/repository';
import {ModelConstructor} from '@sourceloop/core';
import {IModelConfig} from './types';

export function isModelWithPermission(m: IModelConfig): m is {
  model: ModelConstructor<Entity>;
  readPermissionKey: string;
} {
  return (m as {readPermissionKey?: string}).readPermissionKey !== undefined;
}

export function getModelFromConfig(m: IModelConfig): ModelConstructor<Entity> {
  return isModelWithPermission(m) ? m.model : m;
}
