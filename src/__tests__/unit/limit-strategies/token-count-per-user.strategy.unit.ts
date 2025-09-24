import {expect, sinon} from '@loopback/testlab';
import {HttpErrors} from '@loopback/rest';
import {TokenCountPerUserStrategy} from '../../../services';
import {AIIntegrationConfig} from '../../../types';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {ChatRepository} from '../../../repositories';
import {Chat} from '../../../models';
import {Condition, PredicateComparison} from '@loopback/repository';
import {fail} from 'assert';

describe('TokenCountPerUserStrategy Unit', function () {
  let strategy: TokenCountPerUserStrategy;
  let config: AIIntegrationConfig;
  let user: IAuthUserWithPermissions;
  let chatRepo: sinon.SinonStubbedInstance<ChatRepository>;

  beforeEach(() => {
    // Mock config
    config = {
      tokenCounterConfig: {
        period: 3600, // 1 hour
        bufferTokens: 100,
      },
    } as AIIntegrationConfig;

    // Mock user with permissions
    user = {
      tenantId: 'test-tenant',
      userTenantId: 'test-user',
      permissions: ['TokenUsage:1000'],
    } as IAuthUserWithPermissions;

    // Mock chat repository
    chatRepo = sinon.createStubInstance(ChatRepository);
  });

  it('should throw HttpErrors.InternalServerError when token limit strategy is not configured properly', async () => {
    // Create strategy with missing tokenCounterConfig
    strategy = new TokenCountPerUserStrategy(
      {} as AIIntegrationConfig,
      user,
      chatRepo,
    );

    try {
      await strategy.check();
      fail(`Expected method to throw.`);
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.InternalServerError);
      expect(err).to.have.property(
        'message',
        'Token limit strategy not configured properly',
      );
    }
  });

  it('should throw HttpErrors.Forbidden when user does not have token usage permission', async () => {
    // Create user without TokenUsage permission
    const userWithoutPermission = {
      tenantId: 'test-tenant',
      userTenantId: 'test-user',
      permissions: ['OtherPermission'],
    } as IAuthUserWithPermissions;

    strategy = new TokenCountPerUserStrategy(
      config,
      userWithoutPermission,
      chatRepo,
    );

    try {
      await strategy.check();
      fail(`Expected method to throw.`);
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.Forbidden);
      expect(err).to.have.property(
        'message',
        'User does not have permission to use tokens.',
      );
    }
  });

  it('should throw HttpErrors.Forbidden when user token usage permission is invalid', async () => {
    // Create user with invalid TokenUsage permission
    const userWithInvalidPermission = {
      tenantId: 'test-tenant',
      userTenantId: 'test-user',
      permissions: ['TokenUsage:not-a-number'],
    } as IAuthUserWithPermissions;

    strategy = new TokenCountPerUserStrategy(
      config,
      userWithInvalidPermission,
      chatRepo,
    );

    try {
      await strategy.check();
      fail(`Expected method to throw.`);
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.Forbidden);
      expect(err).to.have.property(
        'message',
        'User does not have permission to use tokens.',
      );
    }
  });

  it('should not throw error when token usage is within limit', async () => {
    // Mock chat repository to return chats with total tokens below limit
    chatRepo.find.resolves([
      new Chat({
        inputTokens: 200,
        outputTokens: 150,
      }),
      new Chat({
        inputTokens: 100,
        outputTokens: 50,
      }),
    ] as Chat[]);

    strategy = new TokenCountPerUserStrategy(config, user, chatRepo);

    // Should not throw any error
    await expect(strategy.check()).to.be.fulfilled();
  });

  it('should not apply any limits if user has TokenUsage:unlimited permission', async () => {
    // Create user with unlimited TokenUsage permission
    const unlimitedUser = {
      tenantId: 'test-tenant',
      userTenantId: 'test-user',
      permissions: ['TokenUsage:unlimited'],
    } as IAuthUserWithPermissions;

    // Mock chat repository to return chats with high token usage
    chatRepo.find.resolves([
      new Chat({
        inputTokens: 1000,
        outputTokens: 800,
      }),
      new Chat({
        inputTokens: 500,
        outputTokens: 400,
      }),
    ] as Chat[]);

    strategy = new TokenCountPerUserStrategy(config, unlimitedUser, chatRepo);

    // Should not throw any error since user has unlimited tokens
    await expect(strategy.check()).to.be.fulfilled();
  });

  it('should throw HttpErrors.Forbidden when token usage exceeds limit', async () => {
    // Mock chat repository to return chats with total tokens above limit
    chatRepo.find.resolves([
      new Chat({
        inputTokens: 600,
        outputTokens: 450,
      }),
      new Chat({
        inputTokens: 100,
        outputTokens: 50,
      }),
    ] as Chat[]);

    strategy = new TokenCountPerUserStrategy(config, user, chatRepo);

    try {
      // User has 1000 token limit
      // Total tokens used: 1200 (600+450+100+50)
      // Should throw error since 1200 > 1000
      await strategy.check();
      fail('Expected error was not thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.Forbidden);
      expect(err).to.have.property(
        'message',
        'You have reached the token limit. Please try again in a while.',
      );
    }
  });

  it('should consider buffer tokens when checking limits', async () => {
    // Mock chat repository to return chats with total tokens that exceed limit minus buffer
    chatRepo.find.resolves([
      new Chat({
        inputTokens: 500,
        outputTokens: 400,
      }),
      new Chat({
        inputTokens: 50,
        outputTokens: 50,
      }),
    ] as Chat[]);

    strategy = new TokenCountPerUserStrategy(config, user, chatRepo);

    try {
      // User has 1000 token limit with 100 buffer tokens
      // Actual limit should be 900 (1000 - 100)
      // Total tokens used: 1000 (500+400+50+50)
      // Should throw error since 1000 >= 900
      await strategy.check();
      fail('Expected error was not thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.Forbidden);
      expect(err).to.have.property(
        'message',
        'You have reached the token limit. Please try again in a while.',
      );
    }
  });

  it('should correctly calculate time period for chat filtering', async () => {
    // Mock chat repository to verify the time period filter
    chatRepo.find.resolves([] as Chat[]);

    strategy = new TokenCountPerUserStrategy(config, user, chatRepo);

    await strategy.check();

    // Verify that the find method was called with correct time period filter
    expect(chatRepo.find.calledOnce).to.be.true();
    const findArgs = chatRepo.find.getCall(0).args[0];

    const modifiedOn = (findArgs?.where as Condition<Chat>)
      ?.modifiedOn as PredicateComparison<Chat['modifiedOn']>;
    if (!modifiedOn) {
      throw new Error('modifiedOn filter not found in query arguments');
    }

    // Check that the time filter is calculated correctly
    const expectedTime = new Date(
      Date.now() - config.tokenCounterConfig!.period * 1000,
    );
    // We're not strictly checking property names due to TypeScript constraints
    // but verifying that a time filter is applied
    expect(modifiedOn.gte).to.be.instanceOf(Date);
    const actualTime = modifiedOn.gte as Date;
    // Allow 1000ms difference due to execution time
    expect(
      Math.abs(actualTime.getTime() - expectedTime.getTime()),
    ).to.be.lessThan(1000);
  });
});
