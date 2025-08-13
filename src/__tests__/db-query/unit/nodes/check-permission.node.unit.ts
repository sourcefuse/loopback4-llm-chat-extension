import {expect, sinon} from '@loopback/testlab';
import {IAuthUserWithPermissions} from 'loopback4-authorization';
import {
  CheckPermissionsNode,
  DbQueryState,
  Errors,
  PermissionHelper,
} from '../../../../components';
import {LLMProvider} from '../../../../types';
import {Currency, Employee, ExchangeRate} from '../../../fixtures/models';

describe('CheckPermissionsNode Unit', function () {
  let node: CheckPermissionsNode;
  let llmStub: sinon.SinonStub;

  beforeEach(() => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;
    const permissionHelper = new PermissionHelper(
      {
        models: [
          {
            model: Employee,
            readPermissionKey: '1',
          },
          {
            model: ExchangeRate,
            readPermissionKey: '2',
          },
          {
            model: Currency,
            readPermissionKey: '3',
          },
        ],
      },
      {
        tenantId: 'test-tenant',
        userTenantId: 'test-tenant',
        permissions: ['1'],
      } as unknown as IAuthUserWithPermissions,
    );
    node = new CheckPermissionsNode(llm, permissionHelper);
  });

  it('should return state as it is if no permission is missing', async () => {
    const state = {
      schema: {
        tables: {
          employees: {},
        },
      },
    } as unknown as DbQueryState;
    const result = await node.execute(state, {});
    expect(result).to.deepEqual(state);
  });

  it('should permission error status when a permission is missing', async () => {
    llmStub.resolves({
      content:
        'You do not have permissions to access the required tables and cannot proceed with the request. Please provide a new request.',
    });
    const state = {
      schema: {
        tables: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          exchange_rates: {},
        },
      },
    } as unknown as DbQueryState;
    const result = await node.execute(state, {});
    expect(result).to.deepEqual({
      ...state,
      status: Errors.PermissionError,
      replyToUser:
        'You do not have permissions to access the required tables and cannot proceed with the request. Please provide a new request.',
    });
  });
});
