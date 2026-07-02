import type {IAuthUserWithPermissions} from '@sourceloop/core';

/**
 * Canonical string format for a Mastra Memory `resourceId`.
 * Centralised here so the runtime writer, the controller reader, and the
 * backfill script all produce identical strings — changing the format in one
 * place changes it everywhere.
 */
export function formatResourceId(
  tenantId: string,
  principalId: string,
): string {
  return `${tenantId}:${principalId}`;
}

/**
 * Stable principal id for a request user — `user.id` when present, else the
 * user-tenant id. Used to build the Mastra Memory `resourceId`.
 */
export function resolvePrincipalId(
  user: IAuthUserWithPermissions | undefined,
): string | undefined {
  if (!user) return undefined;
  // Prefer userTenantId: v2 keyed ALL ownership on it (chat.userId =
  // currentUser.userTenantId, dataset/action userId, and the backfill script's
  // resourceId), so the runtime must too — otherwise resume/list reads the
  // wrong Memory scope and migrated threads orphan when user.id != userTenantId.
  // Fall back to user.id for single-tenant deployments with no userTenantId.
  if (typeof user.userTenantId === 'string') return user.userTenantId;
  return typeof user.id === 'string' ? user.id : undefined;
}

/**
 * Derive the Mastra Memory `resourceId` for the current request. A consumer
 * may bind `AiIntegrationBindings.ResourceId` to override; otherwise it is
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
  return formatResourceId(user.tenantId, principalId);
}
