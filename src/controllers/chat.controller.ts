import {service} from '@loopback/core';
import {Filter, FilterExcludingWhere} from '@loopback/repository';
import {get, param} from '@loopback/rest';
import {OPERATION_SECURITY_SPEC} from '@sourceloop/core';
import {authenticate, STRATEGY} from 'loopback4-authentication';
import {authorize} from 'loopback4-authorization';
import {ChatStore} from '../graphs/chat/chat.store';
import {Chat} from '../models';
import {PermissionKey} from '../permissions';

export class ChatController {
  constructor(
    @service(ChatStore)
    private readonly chatStore: ChatStore,
  ) {}

  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @authorize({permissions: [PermissionKey.ViewChat]})
  @get('/chats/{id}', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      '200': {},
    },
  })
  async findById(
    @param.path.string('id')
    chatId: string,
    @param.filter(Chat, {exclude: ['where']})
    filter?: FilterExcludingWhere<Chat>,
  ) {
    return this.chatStore.findById(chatId, filter);
  }

  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @authorize({permissions: [PermissionKey.ViewChat]})
  @get('/chats', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      '200': {},
    },
  })
  async find(
    @param.filter(Chat)
    filter?: Filter<Chat>,
  ) {
    return this.chatStore.find(filter);
  }
}
