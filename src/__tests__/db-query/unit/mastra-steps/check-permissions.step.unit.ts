import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {Errors} from '../../../../components/db-query/types';
import {checkPermissionsStep} from '../../../../mastra/db-query/workflow/steps/check-permissions.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {LLMProvider} from '../../../../types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

describe('checkPermissionsStep (Mastra)', function () {
  const baseState = {
    prompt: 'Show all salaries',
    schema: {
      tables: {
        'public.employees': {columns: []},
        'public.salaries': {columns: []},
      },
      relations: [],
    },
  } as unknown as DbQueryState;

  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy} as unknown as MastraDbQueryContext;
  });

  it('returns empty when all permissions are granted', async () => {
    const permissions = {findMissingPermissions: sinon.stub().returns([])};

    const result = await checkPermissionsStep(baseState, context, {
      llm: createFakeLanguageModel('unused') as unknown as LLMProvider,
      permissions: permissions as never,
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(onUsageSpy);
  });

  it('sets PermissionError status when missing permissions', async () => {
    const permissions = {
      findMissingPermissions: sinon.stub().returns(['salaries_read']),
    };

    const result = await checkPermissionsStep(baseState, context, {
      llm: createFakeLanguageModel(
        'You do not have access to salary data',
      ) as unknown as LLMProvider,
      permissions: permissions as never,
    });

    expect(result.status).to.equal(Errors.PermissionError);
    expect(result.replyToUser).to.equal(
      'You do not have access to salary data',
    );
    sinon.assert.calledOnce(onUsageSpy);
  });

  it('calls findMissingPermissions with lowercase table names (without schema prefix)', async () => {
    const permissions = {findMissingPermissions: sinon.stub().returns([])};

    await checkPermissionsStep(baseState, context, {
      llm: createFakeLanguageModel('unused') as unknown as LLMProvider,
      permissions: permissions as never,
    });

    const tableNames: string[] =
      permissions.findMissingPermissions.firstCall.args[0];
    expect(tableNames).to.containDeep(['employees', 'salaries']);
  });
});
