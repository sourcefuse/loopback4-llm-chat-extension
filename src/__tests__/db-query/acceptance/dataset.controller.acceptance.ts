import {Context} from '@loopback/core';
import {Client, expect, sinon} from '@loopback/testlab';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from 'loopback4-authorization';
import {DataSet} from '../../../components/db-query/models';
import {DataSetRepository} from '../../../components/db-query/repositories';
import {AiIntegrationBindings} from '../../../keys';
import {PermissionKey} from '../../../permissions';
import {EmbeddingProvider} from '../../../types';
import {TestApp} from '../../fixtures/test-app';
import {buildToken, seedEmployees, setupApplication} from '../../test-helper';

describe('DatasetController', () => {
  let app: TestApp;
  let client: Client;
  let dummyDataset: DataSet;
  let llmStub: sinon.SinonStub;

  before('setupApplication', async () => {
    ({app, client} = await setupApplication({
      noKnowledgeGraph: true,
      llmStub: sinon.stub(),
    }));
    llmStub = sinon.stub();
    llmStub.resolves([[0.1, 0.2, 0.3]]);

    app.bind(AiIntegrationBindings.EmbeddingModel).to({
      embedDocuments: llmStub,
    } as unknown as EmbeddingProvider);
    await seedEmployees(app);
    await seedDataset(app);
  });

  after(async () => {
    await app.stop();
  });

  describe('GET /datasets/{id}/execute', () => {
    it('should execute the dataset query and return the results', async () => {
      // build token with employee permissions
      const token = buildToken(['1', PermissionKey.ExecuteDataset]);
      const {body} = await client
        .get(`/datasets/${dummyDataset.id}/execute`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(body).to.be.an.Array();
      expect(body.length).to.be.greaterThan(seedEmployees.length);
    });
    it('should return 401 if the user does not have permission of the tables in the dataset', async () => {
      // build token without employee permissions
      const token = buildToken([PermissionKey.ExecuteDataset]);
      await client
        .get(`/datasets/${dummyDataset.id}/execute`)
        .set('authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('should return 403 if the user does not have permission of the execute api', async () => {
      // build token without employee permissions
      const token = buildToken(['1']);
      await client
        .get(`/datasets/${dummyDataset.id}/execute`)
        .set('authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('GET /datasets/{id}', () => {
    it('should return the dataset by id', async () => {
      const {body} = await client
        .get(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.ViewDataset])}`,
        )
        .expect(200);
      expect(body).to.have.property('id', dummyDataset.id);
      // response should not contain query
      expect(body).to.not.have.property('query');
    });

    it('should return 404 if dataset not found', async () => {
      await client
        .get('/datasets/invalid-id')
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.ViewDataset])}`,
        )
        .expect(404);
    });
  });

  describe(`PATCH /datasets/{id}`, () => {
    it('should update the dataset as invalid with feedback', async () => {
      const updatedData = {
        valid: false,
        feedback: 'This dataset is invalid',
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(204);
    });
    it('should throw error if marking dataset as invalid without feedback', async () => {
      const updatedData = {
        valid: false,
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(422);
    });
    it('should update the dataset as valid', async () => {
      const updatedData = {
        valid: true,
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(204);
    });
    it('should return 404 if dataset not found', async () => {
      await client
        .patch('/datasets/invalid-id')
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({valid: true})
        .expect(404);
    });
    it('should return 403 if the user does not have permission to update the dataset', async () => {
      const updatedData = {
        valid: true,
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set('authorization', `Bearer ${buildToken(['1'])}`)
        .send(updatedData)
        .expect(403);
    });
  });

  async function seedDataset(appInstance: TestApp) {
    const ctx = new Context(appInstance);
    ctx.bind(AuthenticationBindings.CURRENT_USER).to({
      id: 'test-user',
      userTenantId: 'default',
    } as unknown as IAuthUserWithPermissions);
    const repo = await ctx.get<DataSetRepository>(
      `repositories.${DataSetRepository.name}`,
    );
    dummyDataset = await repo.create({
      tenantId: 'default',
      description: 'This is a test dataset',
      query: 'SELECT * FROM employees',
      tables: ['employees'],
      schemaHash: 'test-hash',
      prompt: 'Test prompt',
      valid: false,
    });
  }
});
