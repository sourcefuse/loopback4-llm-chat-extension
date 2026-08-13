import {expect} from '@loopback/testlab';
import {MockEmbeddingModelV3} from 'ai/test';
import {DbKnowledgeGraphService} from '../../../components';
import {EmbeddingProvider} from '../../../types';
import {LlmService} from '../../../services/llm.service';
import {EmbeddingService} from '../../../services/embedding.service';
import {createMockLLM, MockLLM} from '../../test-helper';

describe(`DbKnowledgeGraphService Unit`, function () {
  let service: DbKnowledgeGraphService;
  let llm: MockLLM;

  beforeEach(() => {
    llm = createMockLLM();
    // A real AI SDK embedding double. The service now embeds via the SDK's
    // `embedMany`, which rejects the old hand-rolled `{embedDocuments}` object.
    // Vectors are chosen so `employee_salaries`/`employees` cluster together and
    // `orders` sits far away — matching the original stub's behaviour.
    const embeddingModel = new MockEmbeddingModelV3({
      doEmbed: async ({values}: {values: string[]}) => ({
        embeddings: values.map(value => {
          if (value.startsWith('employee_salaries')) {
            return [0.1, 0.2, 0.3];
          }
          if (value.startsWith('employees')) {
            return [0.1, 0.2, 0.3];
          }
          if (value.startsWith('orders')) {
            return [0.9, 0.8, 0.7];
          }
          return [0.1, 0.2, 0.6];
        }),
        usage: {tokens: values.length},
        warnings: [],
      }),
    }) as unknown as EmbeddingProvider;
    service = new DbKnowledgeGraphService(
      new LlmService(),
      new EmbeddingService(),
      llm.model,
      embeddingModel,
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
    llm.setText(
      JSON.stringify({
        concept: 'employees',
        description: 'test description',
        domain: 'test domain',
        confidence: 0.9,
      }),
    );
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
