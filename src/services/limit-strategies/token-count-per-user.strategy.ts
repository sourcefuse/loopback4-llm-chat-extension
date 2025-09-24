import {inject} from '@loopback/core';
import {ILimitStrategy} from './types';
import {AiIntegrationBindings} from '../../keys';
import {AIIntegrationConfig} from '../../types';
import {repository} from '@loopback/repository';
import {ChatRepository} from '../../repositories';
import {HttpErrors} from '@loopback/rest';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
const debug = require('debug')(
  'ai-integration:token-guard:token-count-per-user',
);

export class TokenCountPerUserStrategy implements ILimitStrategy {
  constructor(
    @inject(AiIntegrationBindings.Config)
    private readonly config: AIIntegrationConfig,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
    @repository(ChatRepository)
    private readonly chatRepo: ChatRepository,
  ) {}
  async check(): Promise<void> {
    const config = this.config.tokenCounterConfig;
    if (!config?.period) {
      throw new HttpErrors.InternalServerError(
        'Token limit strategy not configured properly',
      );
    }

    const tokenUsageLimitStr =
      this.user.permissions
        ?.find(p => p.startsWith('TokenUsage:'))
        ?.split(':')[1] ?? '';
    if (tokenUsageLimitStr === 'unlimited') return;
    const tokenUsageLimit = parseInt(tokenUsageLimitStr, 10);
    if (isNaN(tokenUsageLimit)) {
      throw new HttpErrors.Forbidden(
        `User does not have permission to use tokens.`,
      );
    }
    const chats = await this.chatRepo.find({
      where: {
        tenantId: this.user.tenantId,
        userId: this.user.userTenantId,
        modifiedOn: {
          gte: new Date(Date.now() - config.period * 1000),
        },
      },
    });
    const totalTokens = chats.reduce(
      (acc, chat) => acc + chat.inputTokens + chat.outputTokens,
      0,
    );
    debug(
      `User ${this.user.userTenantId} has used ${totalTokens} tokens in the last ${config.period} seconds`,
    );

    if (totalTokens >= tokenUsageLimit - (config.bufferTokens ?? 0)) {
      debug(
        `User ${this.user.userTenantId} has reached the token limit of ${tokenUsageLimit} tokens per ${config.period} seconds`,
      );
      throw new HttpErrors.Forbidden(
        `You have reached the token limit. Please try again in a while.`,
      );
    }
  }
}
