import {BindingScope, inject, injectable} from '@loopback/core';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryConfig} from '../types';

@injectable({scope: BindingScope.REQUEST})
export class PermissionHelper {
  constructor(
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
  ) {}

  findMissingPermissions(tables: string[]) {
    const userPermissionsSet = (this.user.permissions || []).reduce(
      (acc, permission) => {
        acc.add(permission);
        return acc;
      },
      new Set(),
    );
    const requiredPermissions = this._requiredPermissions(tables);
    return requiredPermissions.filter(
      permission => !userPermissionsSet.has(permission),
    );
  }

  private _requiredPermissions(tables: string[]): string[] {
    const modelPermissionMap = this.config.models.reduce(
      (acc, model) => {
        if (model.readPermissionKey) {
          acc[model.model.modelName] = model.readPermissionKey;
        }
        return acc;
      },
      {} as Record<string, string>,
    );
    return tables
      .map(table => modelPermissionMap[table] || null)
      .filter((key: string | null): key is string => key !== null);
  }
}
