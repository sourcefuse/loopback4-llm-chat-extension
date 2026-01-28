import {BootMixin} from '@loopback/boot';
import {ApplicationConfig, BindingScope} from '@loopback/core';
import {juggler, RepositoryMixin} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {ServiceMixin} from '@loopback/service-proxy';
import {
  BearerVerifierBindings,
  BearerVerifierComponent,
  BearerVerifierConfig,
  BearerVerifierType,
  ServiceSequence,
} from '@sourceloop/core';
import {AuthenticationComponent} from 'loopback4-authentication';
import {
  AuthorizationBindings,
  AuthorizationComponent,
} from 'loopback4-authorization';
import {AiIntegrationsComponent} from '../../component';
import {
  DbQueryAIExtensionBindings,
  DbQueryComponent,
  SqliteConnector,
} from '../../components';
import {AiIntegrationBindings} from '../../keys';
import {InMemoryVectorStore} from '../../providers';
import {SupportedDBs} from '../../types';
import {Currency, ExchangeRate} from './models';
import {Employee} from './models/employee.model';
import {EmployeeRepository} from './repositories';
import {Ollama, OllamaEmbedding} from '../../sub-modules/providers/ollama';
import {Cerebras} from '../../sub-modules/providers/cerebras';
import {sinon} from '@loopback/testlab';
export class TestApp extends BootMixin(
  ServiceMixin(RepositoryMixin(RestApplication)),
) {
  constructor(options: ApplicationConfig = {}) {
    super(options);
    this.model(Employee);
    this.repository(EmployeeRepository);
    this.bind(AiIntegrationBindings.Config).to({
      useCustomSequence: true,
    });
    if (process.env.OLLAMA === '1') {
      this.bind(AiIntegrationBindings.CheapLLM).toProvider(Ollama);
      this.bind(AiIntegrationBindings.SmartLLM).toProvider(Ollama);
      this.bind(AiIntegrationBindings.FileLLM).toProvider(Ollama);
      this.bind(AiIntegrationBindings.ChatLLM).toProvider(Ollama);
      this.bind(AiIntegrationBindings.EmbeddingModel).toProvider(
        OllamaEmbedding,
      );
    } else if (process.env.CEREBRAS === '1') {
      this.bind(AiIntegrationBindings.CheapLLM).toProvider(Cerebras);
      this.bind(AiIntegrationBindings.SmartLLM).toProvider(Cerebras);
      this.bind(AiIntegrationBindings.FileLLM).toProvider(Cerebras);
      this.bind(AiIntegrationBindings.ChatLLM).toProvider(Cerebras);
      this.bind(AiIntegrationBindings.EmbeddingModel).toProvider(
        OllamaEmbedding,
      );
    } else if (options.llmStub) {
      this.bind(AiIntegrationBindings.CheapLLM).to(options.llmStub);
      this.bind(AiIntegrationBindings.SmartLLM).to(options.llmStub);
      this.bind(AiIntegrationBindings.FileLLM).to(options.llmStub);
      this.bind(AiIntegrationBindings.ChatLLM).to(options.llmStub);
      this.bind(AiIntegrationBindings.EmbeddingModel).to(options.llmStub);
    }
    this.bind('datasources.readerdb').to(
      new juggler.DataSource({
        connector: 'sqlite3',
        file: ':memory:',
        name: 'db',
        debug: true,
      }),
    );

    const ds = new juggler.DataSource({
      connector: 'memory',
      name: 'datasetdb',
    });

    const beginTransactionStub = sinon.stub().resolves({
      commit: sinon.stub().resolves(),
      rollback: sinon.stub().resolves(),
    });
    ds.beginTransaction = beginTransactionStub;
    this.bind('datasources.writerdb').to(ds);
    this.component(AiIntegrationsComponent);
    this.bind(DbQueryAIExtensionBindings.Config).to({
      models: [
        {
          model: Employee,
          readPermissionKey: '1',
        },
        {
          model: Currency,
          readPermissionKey: '2',
        },
        {
          model: ExchangeRate,
          readPermissionKey: '3',
        },
      ],
      db: {
        dialect: SupportedDBs.SQLite,
        schema: '',
      },
      noKnowledgeGraph: options.noKnowledgeGraph ?? false,
    });
    this.component(DbQueryComponent);
    this.bind(DbQueryAIExtensionBindings.Connector)
      .toClass(SqliteConnector)
      .inScope(BindingScope.TRANSIENT);

    this.bind(AiIntegrationBindings.VectorStore)
      .toProvider(InMemoryVectorStore)
      .inScope(BindingScope.SINGLETON);

    this.sequence(ServiceSequence);

    // Mount authentication component for default sequence
    this.component(AuthenticationComponent);
    // Mount bearer verifier component
    this.bind(BearerVerifierBindings.Config).to({
      authServiceUrl: '',
      type: BearerVerifierType.service,
      useSymmetricEncryption: true,
    } as BearerVerifierConfig);
    this.component(BearerVerifierComponent);

    // Mount authorization component for default sequence
    this.bind(AuthorizationBindings.CONFIG).to({
      allowAlwaysPaths: ['/explorer'],
    });
    this.component(AuthorizationComponent);
    this.projectRoot = __dirname;
    // Customize @loopback/boot Booter Conventions here
    this.bootOptions = {
      controllers: {
        // Customize ControllerBooter Conventions here
        dirs: ['controllers'],
        extensions: ['.controller.js'],
        nested: true,
      },
    };
  }
}
