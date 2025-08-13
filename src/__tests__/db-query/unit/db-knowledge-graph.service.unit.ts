import {expect, sinon} from '@loopback/testlab';
import {DbKnowledgeGraphService} from '../../../components';
import {EmbeddingProvider, LLMProvider} from '../../../types';

describe(`DbKnowledgeGraphService Unit`, function () {
  let service: DbKnowledgeGraphService;
  let llmStub: sinon.SinonStub;
  let embedStub: sinon.SinonStub;

  beforeEach(() => {
    llmStub = sinon.stub();
    embedStub = sinon.stub();
    service = new DbKnowledgeGraphService(
      llmStub as unknown as LLMProvider,
      {
        embedDocuments: embedStub,
      } as unknown as EmbeddingProvider,
      {
        models: [],
        knowledgeGraph: {
          graphWeight: 0.5,
          vectorWeight: 0.5,
          clusterThreshold: 0.7,
          conceptThreshold: 0.8,
        },
      },
    );
  });

  it('should generate a knowledge graph for a schema and should be able to find from it', async () => {
    embedStub.callsFake(async doc => {
      if (doc[0].startsWith('employee_salaries')) {
        return [[0.1, 0.2, 0.3]];
      }
      if (doc[0].startsWith('employees')) {
        return [[0.1, 0.2, 0.3]];
      }
      if (doc[0].startsWith('orders')) {
        return [[0.9, 0.8, 0.7]];
      }
      return [[0.1, 0.2, 0.6]];
    });
    llmStub.resolves({
      content: JSON.stringify({
        concept: 'employees',
        description: 'test description',
        domain: 'test domain',
        confidence: 0.9,
      }),
    });
    const schema = {
      tables: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        employee_salaries: {
          description: 'User data',
          context: ['User information'],
          columns: {
            id: {
              type: 'string',
              description: 'Employee ID',
              required: true,
              id: true,
            },
            salary: {
              type: 'number',
              description: 'Employee Salary',
              required: true,
              id: false,
            },
          },
          primaryKey: ['id'],
          hash: '',
        },
        orders: {
          description: 'Order data',
          context: ['Order information'],
          columns: {
            id: {
              type: 'string',
              description: 'Order ID',
              required: true,
              id: true,
            },
            amount: {
              type: 'number',
              description: 'Order Amount',
              required: true,
              id: false,
            },
          },
          primaryKey: ['id'],
          hash: '',
        },
        employees: {
          description: 'Employee data',
          context: ['Employee information'],
          columns: {
            id: {
              type: 'string',
              description: 'Employee ID',
              required: true,
              id: true,
            },
            salary: {
              type: 'number',
              description: 'Employee Salary',
              required: true,
              id: false,
            },
          },
          primaryKey: ['id'],
          hash: '',
        },
      },
      relations: [],
    };
    await service.seed(schema);

    const result = await service.find('employees', 2);
    expect(result).to.have.length(2);
    expect(result).to.deepEqual(['employee_salaries', 'employees']);
  });
});
