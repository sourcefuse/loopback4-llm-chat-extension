import {expect} from '@loopback/testlab';
import {IAuthUserWithPermissions} from 'loopback4-authorization';
import {
  CheckPermissionsNode,
  DbQueryState,
  Errors,
  PermissionHelper,
} from '../../../../components';
import {LlmService} from '../../../../services/llm.service';
import {createMockLLM, MockLLM} from '../../../test-helper';
import {Currency, Employee, ExchangeRate} from '../../../fixtures/models';

describe('CheckPermissionsNode Unit', function () {
  let node: CheckPermissionsNode;
  let llm: MockLLM;

  beforeEach(() => {
    llm = createMockLLM();
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
    node = new CheckPermissionsNode(
      new LlmService(),
      llm.model,
      permissionHelper,
    );
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
    llm.setText(
      'You do not have permissions to access the required tables and cannot proceed with the request. Please provide a new request.',
    );
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
