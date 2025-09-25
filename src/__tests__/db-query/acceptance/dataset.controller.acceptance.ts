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
import {
  buildToken,
  getRepo,
  seedEmployees,
  setupApplication,
} from '../../test-helper';
import {DatasetActionType} from '../../../components';

describe('DatasetController', () => {
  let app: TestApp;
  let client: Client;
  let dummyDataset: DataSet;
  let llmStub: sinon.SinonStub;
  let repo: DataSetRepository;

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
    repo = await getRepo(app, DataSetRepository.name);
  });

  after(async () => {
    await app.stop();
  });

  afterEach(async () => {
    // reset votes and actions
    await repo.updateById(dummyDataset.id, {votes: 0});
    await repo.actions(dummyDataset.id).delete({});
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
    it('should update the dataset as disliked with feedback', async () => {
      const updatedData = {
        liked: false,
        comment: 'This dataset is invalid',
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(204);

      const dataset = await repo.findById(dummyDataset.id, {
        include: ['actions'],
      });
      expect(dataset).to.have.property('votes', -1);
      expect(dataset.actions).to.be.Array();
      expect(dataset.actions).to.have.length(1);
      expect(dataset.actions![0]).to.have.property(
        'action',
        DatasetActionType.Disliked /* DatasetActionType.Disliked */,
      );
      expect(dataset.actions![0]).to.have.property(
        'comment',
        'This dataset is invalid',
      );
    });
    it('should throw error if marking dataset as disliked without feedback', async () => {
      const updatedData = {
        liked: false,
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
    it('should update the dataset as liked', async () => {
      const updatedData = {
        liked: true,
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(204);

      const dataset = await repo.findById(
        dummyDataset.id,
        {
          include: ['actions'],
        },
        {skipUserFilter: true},
      );
      expect(dataset).to.have.property('votes', 1);
      expect(dataset.actions).to.be.Array();
      expect(dataset.actions).to.have.length(1);
      expect(dataset.actions![0]).to.have.property(
        'action',
        DatasetActionType.Liked /* DatasetActionType.Disliked */,
      );
      expect(dataset.actions![0]).to.have.property('comment', undefined);
    });
    it('should not allow the user to like twice', async () => {
      const updatedData = {
        liked: true,
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(204);

      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        // conflict error
        .expect(409);
    });
    it('should clear likes when null is sent', async () => {
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({liked: true})
        .expect(204);
      const updatedData = {
        liked: null,
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(204);

      const dataset = await repo.findById(dummyDataset.id, {
        include: ['actions'],
      });
      expect(dataset).to.have.property('votes', 0);
      expect(dataset.actions).to.be.undefined();
    });
    it('should clear dislikes when null is sent', async () => {
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({liked: false, comment: 'Not good'})
        .expect(204);
      const updatedData = {
        liked: null,
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(204);

      const dataset = await repo.findById(dummyDataset.id, {
        include: ['actions'],
      });
      expect(dataset).to.have.property('votes', 0);
      expect(dataset.actions).to.be.undefined();
    });
    it('should not allow null if no likes/dislikes exist for this user', async () => {
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset], 'non-default')}`,
        )
        .send({liked: true})
        .expect(204);
      const updatedData = {
        liked: null,
      };
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send(updatedData)
        .expect(400);
    });
    it('should increment votes for different user', async () => {
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({liked: true})
        .expect(204);

      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset], 'non-default')}`,
        )
        .send({liked: true})
        .expect(204);
      const dataset = await repo.findById(
        dummyDataset.id,
        {
          include: ['actions'],
        },
        {skipUserFilter: true},
      );
      expect(dataset).to.have.property('votes', 2);
      expect(dataset.actions).to.be.Array();
      expect(dataset.actions).to.have.length(2);
    });
    it('should cancel votes for different users', async () => {
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({liked: true})
        .expect(204);

      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset], 'non-default')}`,
        )
        .send({liked: false, comment: 'Not good'})
        .expect(204);
      const dataset = await repo.findById(
        dummyDataset.id,
        {
          include: ['actions'],
        },
        {skipUserFilter: true},
      );
      expect(dataset).to.have.property('votes', 0);
      expect(dataset.actions).to.be.Array();
      expect(dataset.actions).to.have.length(2);
    });
    it('should handle muliple dislikes from different users', async () => {
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({liked: false, comment: 'Not good'})
        .expect(204);

      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset], 'non-default')}`,
        )
        .send({liked: false, comment: 'Not good'})
        .expect(204);
      const dataset = await repo.findById(
        dummyDataset.id,
        {
          include: ['actions'],
        },
        {skipUserFilter: true},
      );
      expect(dataset).to.have.property('votes', -2);
      expect(dataset.actions).to.be.Array();
      expect(dataset.actions).to.have.length(2);
    });
    it('should allow same user to like then dislike', async () => {
      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({liked: true})
        .expect(204);

      await client
        .patch(`/datasets/${dummyDataset.id}`)
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({liked: false, comment: 'Not good'})
        .expect(204);
      const dataset = await repo.findById(dummyDataset.id, {
        include: ['actions'],
      });
      expect(dataset).to.have.property('votes', -1);
      expect(dataset.actions).to.be.Array();
      expect(dataset.actions).to.have.length(1);
    });
    it('should return 404 if dataset not found', async () => {
      await client
        .patch('/datasets/invalid-id')
        .set(
          'authorization',
          `Bearer ${buildToken(['1', PermissionKey.UpdateDataset])}`,
        )
        .send({liked: true})
        .expect(404);
    });
    it('should return 403 if the user does not have permission to update the dataset', async () => {
      const updatedData = {
        liked: true,
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
      userTenantId: 'default-user-id',
    } as unknown as IAuthUserWithPermissions);
    const dsrepo = await ctx.get<DataSetRepository>(
      `repositories.${DataSetRepository.name}`,
    );
    dummyDataset = await dsrepo.create({
      tenantId: 'default',
      description: 'This is a test dataset',
      query: 'SELECT * FROM employees',
      tables: ['employees'],
      schemaHash: 'test-hash',
      prompt: 'Test prompt',
      votes: 0,
    });
  }
});
