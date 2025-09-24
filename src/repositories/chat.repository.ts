// Copyright (c) 2023 Sourcefuse Technologies
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT
import {Getter, inject} from '@loopback/core';
import {
  HasManyRepositoryFactory,
  juggler,
  repository,
} from '@loopback/repository';
import {
  DefaultUserModifyCrudRepository,
  IAuthUserWithPermissions,
} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {Chat, Message} from '../models';
import {MessageRepository} from './message.repository';
import {WriterDB} from '../keys';

export class ChatRepository extends DefaultUserModifyCrudRepository<
  Chat,
  typeof Chat.prototype.id,
  {}
> {
  public readonly messages: HasManyRepositoryFactory<
    Message,
    typeof Message.prototype.id
  >;

  constructor(
    @inject(`datasources.${WriterDB}`) dataSource: juggler.DataSource,
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    protected readonly getCurrentUser: Getter<
      IAuthUserWithPermissions | undefined
    >,
    @repository.getter('MessageRepository')
    protected messageRepositoryGetter: Getter<MessageRepository>,
  ) {
    super(Chat, dataSource, getCurrentUser);

    this.messages = this.createHasManyRepositoryFactoryFor(
      'messages',
      messageRepositoryGetter,
    );
    this.registerInclusionResolver('messages', this.messages.inclusionResolver);
  }
}
