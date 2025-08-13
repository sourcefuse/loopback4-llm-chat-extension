import {expect} from '@loopback/testlab';
import {DbQueryState, FailedNode} from '../../../../components';

describe('FailedNode Unit', function () {
  let node: FailedNode;

  beforeEach(() => {
    node = new FailedNode();
  });

  it('should return state as it is if it has replyToUser set', async () => {
    const state = {
      schema: {
        tables: {
          employees: {},
        },
      },
      replyToUser: 'Test reply',
    } as unknown as DbQueryState;
    const result = await node.execute(state, {});
    expect(result).to.deepEqual(state);
  });

  it('should return state with feedbacks based response if replyToUser is not set', async () => {
    const state = {
      schema: {
        tables: {
          employees: {},
        },
      },
      feedbacks: ['Error 1', 'Error 2'],
    } as unknown as DbQueryState;
    const result = await node.execute(state, {});
    expect(result).to.deepEqual({
      ...state,
      replyToUser:
        'I am sorry, I was not able to generate a valid SQL query for your request. Please try again with a more detailed or a more specific prompt.\n' +
        'These were the errors I encountered:\n' +
        'Error 1\n' +
        'Error 2',
    });
  });

  it('should return state with default feedbacks if no feedbacks are provided', async () => {
    const state = {
      schema: {
        tables: {
          employees: {},
        },
      },
    } as unknown as DbQueryState;
    const result = await node.execute(state, {});
    expect(result).to.deepEqual({
      ...state,
      replyToUser:
        'I am sorry, I was not able to generate a valid SQL query for your request. Please try again with a more detailed or a more specific prompt.\n' +
        'These were the errors I encountered:\nNo errors reported.',
    });
  });
});
