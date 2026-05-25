import {
  Binding,
  BindingScope,
  Component,
  Constructor,
  ControllerClass,
  CoreBindings,
  createBindingFromClass,
  inject,
  LifeCycleObserver,
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
import {GenerationController} from './controllers';
import {WriterDB, AiIntegrationBindings, ReaderDB} from './keys';
import {Chat, Message} from './models';
import {CacheModel} from './providers';
import {RedisCache, RedisCacheRepository} from './providers/cache/redis';
import {ChatRepository, MessageRepository} from './repositories';
import {
  ChatCountStrategy,
  GenerationService,
  TokenCountPerUserStrategy,
  TokenCountStrategy,
} from './services';
import {UsageAccumulator} from './services/usage-accumulator.service';
import {SSETransport} from './transports';
import {AIIntegrationConfig} from './types';
import {PgVectorStore} from './sub-modules/db/postgresql';
import {DefaultMastraStorageProvider} from './providers/mastra/storage.provider';
import {MastraProvider} from './providers/mastra/mastra.provider';
import {DefaultMastraToolsProvider} from './providers/mastra/mastra-tools.provider';
import {InProcessRunRegistry} from './mastra/bridge/run-registry';
import {WorkflowRunner} from './mastra/bridge/workflow-runner';
import {MastraLifecycleObserver} from './observers/mastra-lifecycle.observer';
import {MastraGetDataAsDatasetTool} from './components/db-query/tools/get-data-as-dataset.mastra.tool';
import {MastraImproveDatasetTool} from './components/db-query/tools/improve-dataset.mastra.tool';
import {MastraAskAboutDatasetTool} from './components/db-query/tools/ask-about-dataset.mastra.tool';
import {MastraGenerateVisualizationTool} from './components/visualization/tools/generate-visualization.mastra.tool';

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
      // Mastra v3 singletons — consumers can override MastraStorage with
      // PostgresStore/MongoDBStore/etc. The defaults work zero-config.
      createBindingFromClass(DefaultMastraStorageProvider, {
        key: AiIntegrationBindings.MastraStorage.key,
      }).inScope(BindingScope.SINGLETON),
      createBindingFromClass(MastraProvider, {
        key: AiIntegrationBindings.Mastra.key,
      }).inScope(BindingScope.SINGLETON),
      createBindingFromClass(InProcessRunRegistry, {
        key: AiIntegrationBindings.RunRegistry.key,
      }).inScope(BindingScope.SINGLETON),
      createBindingFromClass(DefaultMastraToolsProvider, {
        key: AiIntegrationBindings.MastraTools.key,
      }).inScope(BindingScope.SINGLETON),
    ];

    this.providers = {
      [AiIntegrationBindings.VectorStore.key]: PgVectorStore,
    };

    this.services = [
      // utils
      GenerationService,
      // mastra v3 services
      UsageAccumulator,
      WorkflowRunner,
      // mastra-flavored tool wrappers — each calls
      // mastra.getWorkflow(...).createRun().start() (ask-about-dataset
      // runs an inline one-shot Mastra Agent instead of a workflow).
      MastraGetDataAsDatasetTool,
      MastraImproveDatasetTool,
      MastraAskAboutDatasetTool,
      MastraGenerateVisualizationTool,
    ];

    this.lifeCycleObservers = [MastraLifecycleObserver];

    this.controllers = [GenerationController];
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

  lifeCycleObservers?: Constructor<LifeCycleObserver>[];

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
