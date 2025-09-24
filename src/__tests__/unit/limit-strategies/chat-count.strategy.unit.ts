import {expect, sinon} from '@loopback/testlab';
import {HttpErrors} from '@loopback/rest';
import {ChatCountStrategy} from '../../../services/limit-strategies';
import {AIIntegrationConfig} from '../../../types';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {ChatRepository} from '../../../repositories';
import {Chat} from '../../../models';
import {Condition, PredicateComparison} from '@loopback/repository';
import {fail} from 'assert';

describe('ChatCountStrategy Unit', function () {
  let strategy: ChatCountStrategy;
  let config: AIIntegrationConfig;
  let user: IAuthUserWithPermissions;
  let chatRepo: sinon.SinonStubbedInstance<ChatRepository>;

  beforeEach(() => {
    // Mock config
    config = {
      tokenCounterConfig: {
        period: 3600, // 1 hour
        chatLimit: 10,
      },
    } as AIIntegrationConfig;

    // Mock user with permissions
    user = {
      tenantId: 'test-tenant',
      userTenantId: 'test-user',
    } as IAuthUserWithPermissions;

    // Mock chat repository
    chatRepo = sinon.createStubInstance(ChatRepository);
  });

  it('should throw HttpErrors.InternalServerError when chat limit strategy is not configured properly', async () => {
    // Create strategy with missing tokenCounterConfig
    strategy = new ChatCountStrategy({} as AIIntegrationConfig, user, chatRepo);

    try {
      await strategy.check();
      fail(`Expected method to throw.`);
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.InternalServerError);
      expect(err).to.have.property(
        'message',
        'Chat limit strategy not configured properly',
      );
    }
  });

  it('should throw HttpErrors.InternalServerError when chatLimit is missing in config', async () => {
    // Create strategy with missing chatLimit
    const configWithoutChatLimit = {
      tokenCounterConfig: {
        period: 3600,
      },
    } as AIIntegrationConfig;

    strategy = new ChatCountStrategy(configWithoutChatLimit, user, chatRepo);

    try {
      await strategy.check();
      fail(`Expected method to throw.`);
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.InternalServerError);
      expect(err).to.have.property(
        'message',
        'Chat limit strategy not configured properly',
      );
    }
  });

  it('should throw HttpErrors.InternalServerError when period is missing in config', async () => {
    // Create strategy with missing period
    const configWithoutPeriod = {
      tokenCounterConfig: {
        chatLimit: 10,
      },
    } as AIIntegrationConfig;

    strategy = new ChatCountStrategy(configWithoutPeriod, user, chatRepo);

    try {
      await strategy.check();
      fail(`Expected method to throw.`);
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.InternalServerError);
      expect(err).to.have.property(
        'message',
        'Chat limit strategy not configured properly',
      );
    }
  });

  it('should not throw error when chat count is within limit', async () => {
    // Mock chat repository to return chats below the limit
    chatRepo.find.resolves([new Chat(), new Chat(), new Chat()] as Chat[]);

    strategy = new ChatCountStrategy(config, user, chatRepo);

    // Should not throw any error since 3 < 10
    await expect(strategy.check()).to.be.fulfilled();
  });

  it('should throw HttpErrors.Forbidden when chat count reaches limit', async () => {
    // Mock chat repository to return chats at the limit
    const chats = [];
    for (let i = 0; i < 10; i++) {
      chats.push(new Chat());
    }
    chatRepo.find.resolves(chats as Chat[]);

    strategy = new ChatCountStrategy(config, user, chatRepo);

    try {
      // Should throw error since 10 >= 10
      await strategy.check();
      fail('Expected error was not thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.Forbidden);
      expect(err).to.have.property(
        'message',
        'You have used up the chat limit. Please try again in a while.',
      );
    }
  });

  it('should throw HttpErrors.Forbidden when chat count exceeds limit', async () => {
    // Mock chat repository to return chats exceeding the limit
    const chats = [];
    for (let i = 0; i < 15; i++) {
      chats.push(new Chat());
    }
    chatRepo.find.resolves(chats as Chat[]);

    strategy = new ChatCountStrategy(config, user, chatRepo);

    try {
      // Should throw error since 15 > 10
      await strategy.check();
      fail('Expected error was not thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.Forbidden);
      expect(err).to.have.property(
        'message',
        'You have used up the chat limit. Please try again in a while.',
      );
    }
  });

  it('should correctly calculate time period for chat filtering', async () => {
    // Mock chat repository to verify the time period filter
    chatRepo.find.resolves([] as Chat[]);

    strategy = new ChatCountStrategy(config, user, chatRepo);

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
