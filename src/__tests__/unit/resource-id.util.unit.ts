import {expect} from '@loopback/testlab';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {
  deriveResourceId,
  resolvePrincipalId,
} from '../../runtime/resource-id.util';

/**
 * The resourceId derivation is the single source of truth shared by the
 * WorkflowRunner (writes threads) and the ChatController (lists/reads them).
 * These assertions lock the format so the two never drift apart.
 */
describe('resource-id util (unit)', () => {
  const user = (over: Partial<IAuthUserWithPermissions> = {}) =>
    ({id: 'u1', userTenantId: 'ut1', tenantId: 't1', ...over}) as never;

  describe('resolvePrincipalId', () => {
    // v2 keyed all ownership (chat.userId, dataset/action userId, backfill
    // resourceId) on userTenantId — the runtime must match or migrated threads
    // orphan when user.id != userTenantId.
    it('prefers userTenantId', () => {
      expect(resolvePrincipalId(user())).to.equal('ut1');
    });
    it('falls back to user.id when userTenantId is not a string', () => {
      expect(
        resolvePrincipalId(user({userTenantId: undefined as never})),
      ).to.equal('u1');
    });
    it('returns undefined for no user', () => {
      expect(resolvePrincipalId(undefined)).to.be.undefined();
    });
  });

  describe('deriveResourceId', () => {
    it('builds ${tenantId}:${principalId}', () => {
      expect(deriveResourceId(user())).to.equal('t1:ut1');
    });
    it('prefers an explicitly bound resourceId', () => {
      expect(deriveResourceId(user(), 'custom-resource')).to.equal(
        'custom-resource',
      );
    });
    it('returns undefined when tenantId is missing', () => {
      expect(
        deriveResourceId(user({tenantId: undefined as never})),
      ).to.be.undefined();
    });
    it('returns undefined when there is no user and no bound id', () => {
      expect(deriveResourceId(undefined)).to.be.undefined();
    });
  });
});
