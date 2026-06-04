import type {IAuthUserWithPermissions} from '@sourceloop/core';

/**
 * Stable principal id for a request user — `user.id` when present, else the
 * user-tenant id. Used to build the Mastra Memory `resourceId`.
 */
export function resolvePrincipalId(
  user: IAuthUserWithPermissions | undefined,
): string | undefined {
  if (!user) return undefined;
  if (typeof user.id === 'string') return user.id;
  return user.userTenantId;
}

/**
 * Derive the Mastra Memory `resourceId` for the current request. A consumer
 * may bind `MastraInternalBindings.ResourceId` to override; otherwise it is
 * the tenant-scoped `${tenantId}:${principalId}` (multi-tenant isolation).
 * Returns `undefined` when the user has no resolvable identity.
 *
 * Single source of truth shared by the WorkflowRunner (which WRITES threads
 * under this id) and the ChatController (which LISTS/READS them) — they must
 * never diverge or history reads would query the wrong Memory scope.
 */
export function deriveResourceId(
  user: IAuthUserWithPermissions | undefined,
  boundResourceId?: string,
): string | undefined {
  if (boundResourceId) return boundResourceId;
  const principalId = resolvePrincipalId(user);
  if (!principalId || !user?.tenantId) return undefined;
  return `${user.tenantId}:${principalId}`;
}
