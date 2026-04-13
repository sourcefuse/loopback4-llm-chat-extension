import {
  Binding,
  BindingScope,
  Component,
  ControllerClass,
  CoreBindings,
  createBindingFromClass,
  inject,
  ProviderMap,
  ServiceOrProviderClass,
} from '@loopback/core';
import {Class, Model, Repository} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {
  BearerVerifierBindings,
  BearerVerifierComponent,
  BearerVerifierConfig,
  BearerVerifierType,
  CoreComponent,
  SECURITY_SCHEME_SPEC,
  ServiceSequence,
} from '@sourceloop/core';
import {FileUtilBindings, FileUtilComponent} from '@sourceloop/file-utils';
import {AuthenticationComponent} from 'loopback4-authentication';
import {
  AuthorizationBindings,
  AuthorizationComponent,
} from 'loopback4-authorization';
import {
  DbKnowledgeGraphService,
  DbQueryAIExtensionBindings,
} from './components';
import {DEFAULT_FILE_SIZE, MAX_TOTAL_SIZE} from './constant';
import {ChatController, GenerationController} from './controllers';
import {
  CallLLMNode,
  ChatGraph,
  ChatStore,
  ContextCompressionNode,
  EndSessionNode,
  InitSessionNode,
  RunToolNode,
  SummariseFileNode,
} from './graphs/chat';
import {WriterDB, AiIntegrationBindings, ReaderDB} from './keys';
import {Chat, Message} from './models';
import {CacheModel, ToolsProvider} from './providers';
import {RedisCache, RedisCacheRepository} from './providers/cache/redis';
import {ChatRepository, MessageRepository} from './repositories';
import {
  ChatCountStrategy,
  GenerationService,
  TokenCountPerUserStrategy,
  TokenCountStrategy,
} from './services';
import {TokenCounter} from './services/token-counter.service';
import {SSETransport} from './transports';
import {AIIntegrationConfig} from './types';
import {PgVectorStore} from './sub-modules/db/postgresql';

const debug = require('debug')('ai-integration:log-events:component');
export class AiIntegrationsComponent implements Component {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly application: RestApplication,
    @inject(AiIntegrationBindings.Config, {optional: true})
    private readonly config?: AIIntegrationConfig,
  ) {
    this.bindings = [
      createBindingFromClass(SSETransport, {
        key: AiIntegrationBindings.Transport.key,
      }),
      createBindingFromClass(DbKnowledgeGraphService, {
        key: DbQueryAIExtensionBindings.DbKnowledgeGraph.key,
      }),
      createBindingFromClass(RedisCache, {
        key: AiIntegrationBindings.Cache.key,
      }),
    ];

    this.providers = {
      [AiIntegrationBindings.VectorStore.key]: PgVectorStore,
      [AiIntegrationBindings.Tools.key]: ToolsProvider,
    };

    this.services = [
      // utils
      TokenCounter,
      GenerationService,
      ChatStore,
      // graph
      ChatGraph,
      // nodes
      CallLLMNode,
      RunToolNode,
      InitSessionNode,
      SummariseFileNode,
      ContextCompressionNode,
      EndSessionNode,
    ];

    this.controllers = [GenerationController, ChatController];
    this.models = [Chat, Message, CacheModel];
    this.repositories = [
      ChatRepository,
      MessageRepository,
      RedisCacheRepository,
    ];

    // Mount core component
    if (this.config?.mountCore !== false) {
      this.application.component(CoreComponent);
    }

    if (this.config?.mountFileUtils !== false) {
      this.application.bind(FileUtilBindings.LimitProvider).to({
        get: async () => {
          return {
            sizeLimits: {
              files: 10,
              fileSize: DEFAULT_FILE_SIZE, // 5 MB
              totalSize: MAX_TOTAL_SIZE, // 10 MB
            },
          };
        },
      });
      this.application.component(FileUtilComponent);
    }

    if (this.config?.writerDS) {
      this.application
        .bind(`datasources.${WriterDB}`)
        .toAlias(`datasources.${this.config.writerDS}`);
    }

    if (this.config?.readerDS) {
      this.application
        .bind(`datasources.${ReaderDB}`)
        .toAlias(`datasources.${this.config.readerDS}`);
    }

    if (this.config?.tokenCounterConfig) {
      if (this.config.tokenCounterConfig.chatLimit) {
        debug(
          `Chat limit strategy enabled with ${this.config.tokenCounterConfig.chatLimit} chats per ${this.config.tokenCounterConfig.period} seconds`,
        );
        this.application
          .bind(AiIntegrationBindings.LimitStrategy)
          .toClass(ChatCountStrategy)
          .inScope(BindingScope.REQUEST);
      } else if (
        this.config.tokenCounterConfig.tokenLimit &&
        !this.config.tokenCounterConfig.bufferTokens
      ) {
        debug(
          `Token count per user strategy enabled with ${this.config.tokenCounterConfig.tokenLimit} tokens per ${this.config.tokenCounterConfig.period} seconds`,
        );
        this.application
          .bind(AiIntegrationBindings.LimitStrategy)
          .toClass(TokenCountStrategy)
          .inScope(BindingScope.REQUEST);
      } else if (this.config.tokenCounterConfig.period) {
        debug(
          `Token count per user by token permission strategy enabled with buffer of ${this.config.tokenCounterConfig.bufferTokens ?? 0} tokens and limit of ${this.config.tokenCounterConfig.tokenLimit} tokens per ${this.config.tokenCounterConfig.period} seconds`,
        );
        this.application
          .bind(AiIntegrationBindings.LimitStrategy)
          .toClass(TokenCountPerUserStrategy)
          .inScope(BindingScope.REQUEST);
      } else {
        debug('No limit strategy enabled');
      }
    }

    this.application.api({
      openapi: '3.0.0',
      info: {
        title: 'Reporting Service',
        version: '1.0.0',
      },
      paths: {},
      components: {
        securitySchemes: SECURITY_SCHEME_SPEC,
      },
      servers: [{url: '/'}],
    });

    if (!this.config?.useCustomSequence) {
      // Mount default sequence if needed
      this.setupSequence();
    }
  }

  providers?: ProviderMap = {};

  bindings?: Binding[] = [];

  services: ServiceOrProviderClass[] | undefined;

  /**
   * An optional list of Repository classes to bind for dependency injection
   * via `app.repository()` API.
   */
  repositories?: Class<Repository<Model>>[];

  /**
   * An optional list of Model classes to bind for dependency injection
   * via `app.model()` API.
   */
  models?: Class<Model>[];

  /**
   * An array of controller classes
   */
  controllers?: ControllerClass[];

  /**
   * Setup ServiceSequence by default if no other sequnce provided
   *
   */
  setupSequence() {
    this.application.sequence(ServiceSequence);

    // Mount authentication component for default sequence
    this.application.component(AuthenticationComponent);
    // Mount bearer verifier component
    this.application.bind(BearerVerifierBindings.Config).to({
      authServiceUrl: '',
      type: BearerVerifierType.service,
    } as BearerVerifierConfig);
    this.application.component(BearerVerifierComponent);

    // Mount authorization component for default sequence
    this.application.bind(AuthorizationBindings.CONFIG).to({
      allowAlwaysPaths: ['/explorer'],
    });
    this.application.component(AuthorizationComponent);
  }
}
