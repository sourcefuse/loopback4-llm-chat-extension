import {Context} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {
  Client,
  createRestAppClient,
  givenHttpServerConfig,
  sinon,
} from '@loopback/testlab';
import {config} from 'dotenv';
import {sign} from 'jsonwebtoken';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from 'loopback4-authorization';
import {IDataSetStore} from '../components';
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
  const db = await app.get<juggler.DataSource>('datasources.db');
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
  const db = await app.get<juggler.DataSource>('datasources.db');
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
  const db = await appInstance.get<juggler.DataSource>('datasources.db');
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
  const db = await appInstance.get<juggler.DataSource>('datasources.db');
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
  const db = await app.get<juggler.DataSource>('datasources.db');
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
  const db = await ctx.get<juggler.DataSource>('datasources.db');
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
    valid: false,
  });
}

export function buildToken(permissions: string[]) {
  return sign(
    {
      id: 'test-user',
      userTenantId: 'default',
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

export interface AppWithClient {
  app: TestApp;
  client: Client;
}
