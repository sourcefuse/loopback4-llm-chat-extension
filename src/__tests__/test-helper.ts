import {Application, Context} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {
  Client,
  createRestAppClient,
  givenHttpServerConfig,
  sinon,
} from '@loopback/testlab';
import {MockLanguageModelV3} from 'ai/test';
import {config} from 'dotenv';
import {sign} from 'jsonwebtoken';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from 'loopback4-authorization';
import {IDataSetStore} from '../components';
import {LLMProvider} from '../types';
import {DataSetRepository} from '../components/db-query/repositories';
import {
  CurrencyRepository,
  EmployeeRepository,
  ExchangeRateRepository,
} from './fixtures/repositories';
import {
  testCurrencies,
  testEmployees,
  testExchangeRates,
} from './fixtures/seed-data';
import {TestApp} from './fixtures/test-app';
config();

export async function setupApplication(options: {
  noKnowledgeGraph?: boolean;
  llmStub?: sinon.SinonStub;
}): Promise<AppWithClient> {
  const restConfig = givenHttpServerConfig({
    // Customize the server configuration here.
    // Empty values (undefined, '') will be ignored by the helper.
    //
    // host: process.env.HOST,
    port: 3000,
  });
  setUpEnv();
  const app = new TestApp({
    rest: restConfig,
    ...options,
  });

  app.bind(`datasources.redis`).to(
    new juggler.DataSource({
      connector: 'kv-memory',
      name: 'redis',
    }),
  );

  await app.boot();
  await app.start();

  const client = createRestAppClient(app);

  return {app, client};
}

export function buildDatasetStoreStub() {
  return {
    find: sinon.stub(),
    findById: sinon.stub(),
    updateById: sinon.stub(),
    create: sinon.stub(),
    updateAll: sinon.stub(),
    getData: sinon.stub(),
  } as sinon.SinonStubbedInstance<IDataSetStore>;
}

export async function seedEmployees(app: TestApp) {
  const db = await app.get<juggler.DataSource>('datasources.readerdb');
  await db.execute(`
            CREATE TABLE IF NOT EXISTS employees (
            id integer PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            salary REAL NOT NULL,
            joiningdate DATE NOT NULL,
            currency_id integer NOT NULL,
            FOREIGN KEY (currency_id) REFERENCES currencies(id)
            );`);
  const repo = await app.get<EmployeeRepository>(
    'repositories.EmployeeRepository',
  );
  await repo.createAll(testEmployees);
}

export async function seedCurrencies(app: TestApp) {
  const db = await app.get<juggler.DataSource>('datasources.readerdb');
  await db.execute(`
            CREATE TABLE IF NOT EXISTS currencies (
            id integer PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            code TEXT NOT NULL);`);
  // Add logic to seed currencies if needed
  const repo = await app.get<CurrencyRepository>(
    'repositories.CurrencyRepository',
  );
  await repo.createAll(testCurrencies);
}

export async function setupChats(appInstance: Context | TestApp) {
  const db = await appInstance.get<juggler.DataSource>('datasources.readerdb');
  await db.execute(`
            CREATE TABLE IF NOT EXISTS chats (
            id integer PRIMARY KEY AUTOINCREMENT,
            tenant_id varchar NOT NULL,
            user_id varchar NOT NULL,
            title varchar NOT NULL,
            input_tokens integer NOT NULL,
            output_tokens integer NOT NULL,
            deleted boolean,
            deleted_on TIMESTAMP,
            created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            modified_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_by varchar,
            modified_by varchar
            );`);
}

export async function setupMessages(appInstance: Context | TestApp) {
  const db = await appInstance.get<juggler.DataSource>('datasources.readerdb');
  await db.execute(`
            CREATE TABLE IF NOT EXISTS messages (
            id integer PRIMARY KEY AUTOINCREMENT,
            body varchar NOT NULL,
            channel_id varchar NOT NULL,
            channel_type varchar NOT NULL,
            status integer NOT NULL,
            subject text,
            to_user_id text,
            parent_message_id varchar,
            metadata text,
            deleted boolean,
            deleted_on TIMESTAMP,
            created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            modified_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_by varchar,
            modified_by varchar
            );`);
}

export async function seedExchangeRates(app: TestApp) {
  const db = await app.get<juggler.DataSource>('datasources.readerdb');
  await db.execute(`
            CREATE TABLE IF NOT EXISTS exchange_rates (
            id integer PRIMARY KEY AUTOINCREMENT,
            currency_id integer NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE,
            rate REAL NOT NULL,
            FOREIGN KEY (currency_id) REFERENCES currencies(id));;`);
  // Add logic to seed exchange rates if needed
  const exchangeRateRepo = await app.get<ExchangeRateRepository>(
    'repositories.ExchangeRateRepository',
  );
  await exchangeRateRepo.createAll(testExchangeRates);
}

export async function seedDataset(appInstance: TestApp) {
  const ctx = new Context(appInstance);
  const db = await ctx.get<juggler.DataSource>('datasources.readerdb');
  await db.execute(`
            CREATE TABLE IF NOT EXISTS datasets (
            id integer PRIMARY KEY AUTOINCREMENT,
            query varchar NOT NULL,
            description DATE NOT NULL,
            tables TEXT[] NOT NULL,
            schema_hash TEXT NOT NULL,
            tenant_id varchar NOT NULL,
            prompt TEXT NOT NULL,
            valid boolean NOT NULL DEFAULT false,
            feedback TEXT);`);
  ctx.bind(AuthenticationBindings.CURRENT_USER).to({
    id: 'test-user',
    userTenantId: 'default',
    tenantId: 'default',
  } as unknown as IAuthUserWithPermissions);
  const repo = await ctx.get<DataSetRepository>(
    `repositories.${DataSetRepository.name}`,
  );
  return repo.create({
    tenantId: 'default',
    description: 'This is a test dataset',
    query: 'SELECT * FROM employees',
    tables: ['employees'],
    schemaHash: 'test-hash',
    prompt: 'Test prompt',
  });
}

export function buildToken(
  permissions: string[],
  userTenantId = 'default-user-id',
) {
  return sign(
    {
      id: 'test-user',
      userTenantId,
      permissions,
      tenantId: 'default',
    },
    process.env.JWT_SECRET ?? '',
    {
      expiresIn: 180000,
      issuer: process.env.JWT_ISSUER,
    },
  );
}

function setUpEnv() {
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_TRACING = '0';
  process.env.ENABLE_OBF = '0';
  process.env.REDIS_NAME = 'redis';
  process.env.JWT_SECRET = 'secret';
  process.env.JWT_ISSUER = 'issuer';
  process.env.JWT_EXPIRY = '180000';
}

export function buildNodeStub() {
  return {
    execute: sinon.stub().callsFake(async state => {
      return {
        ...state,
      };
    }),
  };
}

export function stubUser(permissions = ['*']) {
  return {
    id: 'test-user',
    userTenantId: 'default',
    tenantId: 'default',
    permissions,
  } as unknown as IAuthUserWithPermissions;
}

export function buildFileStub() {
  return {
    filename: 'test-file.txt',
    originalname: 'test-file.txt',
    content: 'This is a test file content.',
    type: 'text/plain',
    size: 1024,
  } as unknown as Express.Multer.File;
}

export async function getRepo(app: Application, repo: string) {
  const ctx = new Context(app);
  ctx.bind(AuthenticationBindings.CURRENT_USER).to({
    id: 'test-user',
    userTenantId: 'default-user-id',
    tenantId: 'default',
    role: 'admin',
  } as unknown as IAuthUserWithPermissions);
  return ctx.get<DataSetRepository>(`repositories.${DataSetRepository.name}`);
}

export interface AppWithClient {
  app: TestApp;
  client: Client;
}

interface MockToolCall {
  toolCallId: string;
  toolName: string;
  input: object;
}

/**
 * A fake LLM built on the Vercel AI SDK test double. Replaces the old sinon
 * stubs that impersonated a LangChain chat model (`.invoke`/`.bindTools`).
 * Nodes now call `invokeModel`/`generateText`/`generateObject`, so a real
 * `LanguageModelV3` double is required. It records the prompt text handed to
 * each call so tests can assert on what was sent to the model.
 */
export interface MockLLM {
  model: LLMProvider;
  readonly prompts: string[];
  readonly calls: number;
  /** Sets the text the next generation(s) will return. */
  setText(text: string): void;
  /**
   * Queues a distinct text per generation, in order. Once the queue is
   * exhausted the last entry is reused for any further generations. Replaces
   * the old `stub.onFirstCall()/onSecondCall()` sequencing for nodes that
   * call the model more than once (e.g. retry loops).
   */
  setTextSequence(texts: string[]): void;
  /** Makes the next generation(s) return the given tool calls. */
  setToolCalls(toolCalls: MockToolCall[]): void;
  /** Makes the next generation(s) reject with the given error. */
  rejectWith(error: Error): void;
}

function extractPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return '';
  }
  return (prompt as Array<{content: unknown}>)
    .map(message => {
      const content = message.content;
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        return (content as Array<{text?: string}>)
          .map(part => part.text ?? '')
          .join('');
      }
      return '';
    })
    .join('\n');
}

export function createMockLLM(initialText = ''): MockLLM {
  const state = {
    text: initialText,
    textQueue: [] as string[],
    toolCalls: [] as MockToolCall[],
    error: undefined as Error | undefined,
    prompts: [] as string[],
    calls: 0,
  };

  const doGenerate = (async (options: {prompt: unknown}) => {
    state.calls++;
    state.prompts.push(extractPromptText(options.prompt));
    if (state.error) {
      throw state.error;
    }
    let text = state.text;
    if (state.textQueue.length > 0) {
      // Consume one queued response per call; keep the last one afterwards.
      text =
        state.textQueue.length > 1
          ? (state.textQueue.shift() as string)
          : state.textQueue[0];
    }
    const content: Array<Record<string, unknown>> = [{type: 'text', text}];
    for (const call of state.toolCalls) {
      content.push({
        type: 'tool-call',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: JSON.stringify(call.input),
      });
    }
    return {
      finishReason: state.toolCalls.length > 0 ? 'tool-calls' : 'stop',
      usage: {inputTokens: {total: 1}, outputTokens: {total: 1}},
      content,
      warnings: [],
    };
  }) as unknown as NonNullable<
    ConstructorParameters<typeof MockLanguageModelV3>[0]
  >['doGenerate'];

  const model = new MockLanguageModelV3({doGenerate}) as unknown as LLMProvider;
  // Nodes call `invokeModel`, which spreads `model.defaultSettings` into the AI
  // SDK call. `allowSystemInMessages` lets nodes that build their own system
  // message inline (e.g. summarise-file) pass it through `messages` — the AI
  // SDK otherwise rejects system-role entries in `messages` by default.
  model.defaultSettings = {allowSystemInMessages: true};

  return {
    model,
    get prompts() {
      return state.prompts;
    },
    get calls() {
      return state.calls;
    },
    setText(text: string) {
      state.text = text;
    },
    setTextSequence(texts: string[]) {
      state.textQueue = [...texts];
    },
    setToolCalls(toolCalls: MockToolCall[]) {
      state.toolCalls = toolCalls;
    },
    rejectWith(error: Error) {
      state.error = error;
    },
  };
}
