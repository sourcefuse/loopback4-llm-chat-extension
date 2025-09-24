import {IAuthUserWithPermissions} from '@sourceloop/core';
import {ILimitStrategy} from './types';
import {inject} from '@loopback/core';
import {AiIntegrationBindings} from '../../keys';
import {AIIntegrationConfig} from '../../types';
import {HttpErrors} from '@loopback/rest';
import {AuthenticationBindings} from 'loopback4-authentication';
import {ChatRepository} from '../../repositories';
import {repository} from '@loopback/repository';
const debug = require('debug')('ai-integration:token-guard:chat-count');

export class ChatCountStrategy implements ILimitStrategy {
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
    if (!config?.chatLimit || !config?.period) {
      throw new HttpErrors.InternalServerError(
        'Chat limit strategy not configured properly',
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
    debug(
      `User ${this.user.userTenantId} has made ${chats.length} chats in the last ${config.period} seconds`,
    );
    if (config.chatLimit && chats.length >= config.chatLimit) {
      throw new HttpErrors.Forbidden(
        `You have used up the chat limit. Please try again in a while.`,
      );
    }
  }
}
