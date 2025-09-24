// Copyright (c) 2023 Sourcefuse Technologies
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT
import {Getter, inject} from '@loopback/core';
import {
  BelongsToAccessor,
  HasManyRepositoryFactory,
  juggler,
  repository,
} from '@loopback/repository';
import {
  AttachmentFile,
  MessageRecipient,
  MessageRelations,
} from '@sourceloop/chat-service';
import {
  DefaultUserModifyCrudRepository,
  IAuthUserWithPermissions,
} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {Message} from '../models';
import {WriterDB} from '../keys';

export class MessageRepository extends DefaultUserModifyCrudRepository<
  Message,
  typeof Message.prototype.id,
  MessageRelations
> {
  public readonly messageRecipients: HasManyRepositoryFactory<
    MessageRecipient,
    typeof Message.prototype.id
  >;

  public readonly parentMessage: BelongsToAccessor<
    Message,
    typeof Message.prototype.id
  >;

  public readonly messages: HasManyRepositoryFactory<
    Message,
    typeof Message.prototype.id
  >;
  public readonly attachmentFiles: HasManyRepositoryFactory<
    AttachmentFile,
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
    super(Message, dataSource, getCurrentUser);

    this.messages = this.createHasManyRepositoryFactoryFor(
      'messages',
      messageRepositoryGetter,
    );
    this.registerInclusionResolver('messages', this.messages.inclusionResolver);

    this.parentMessage = this.createBelongsToAccessorFor(
      'parentMessage',
      Getter.fromValue(this),
    );
    this.registerInclusionResolver(
      'parentMessage',
      this.parentMessage.inclusionResolver,
    );
  }
}
