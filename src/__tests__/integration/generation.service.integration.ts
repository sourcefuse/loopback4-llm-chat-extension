import {Request, Response} from '@loopback/rest';
import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab';
import {WorkflowRunner} from '../../mastra/bridge/workflow-runner';
import {GenerationService} from '../../services';
import {HttpTransport, SSETransport} from '../../transports';
import type {LLMStreamEvent} from '../../graphs/event.types';

/** Returns an empty async generator (no events) — stands in for a no-op workflow run. */
function emptyEventStream(): AsyncGenerator<LLMStreamEvent, void, undefined> {
  return (async function* (): AsyncGenerator<
    LLMStreamEvent,
    void,
    undefined
  > {})();
}

/** Returns an async generator that immediately throws the given error. */
function throwingEventStream(
  err: Error,
): AsyncGenerator<LLMStreamEvent, void, undefined> {
  // eslint-disable-next-line require-yield
  return (async function* (): AsyncGenerator<LLMStreamEvent, void, undefined> {
    throw err;
  })();
}

describe(`GenerationService Integration`, () => {
  let service: GenerationService;
  let dummyRequest: Request;
  let dummyResponse: Response;
  let runner: StubbedInstanceWithSinonAccessor<WorkflowRunner>;

  describe('with SSETransport', () => {
    beforeEach(() => {
      runner = createStubInstance(WorkflowRunner);
      dummyResponse = {
        write: sinon.stub(),
        end: sinon.stub(),
        status: sinon.stub(),
        setHeader: sinon.stub(),
      } as unknown as Response;
      dummyRequest = {
        once: sinon.stub(),
      } as unknown as Request;
      const transport = new SSETransport(dummyResponse, dummyRequest);
      service = new GenerationService(runner, transport);
    });
    it('should handle generation request and return response', async () => {
      // WorkflowRunner.executeChatWorkflow is now an async generator — return an empty stream
      runner.stubs.executeChatWorkflow.returns(emptyEventStream());

      await service.generate('test prompt', []);

      expect(runner.stubs.executeChatWorkflow.calledOnce).to.be.true();
      const args = runner.stubs.executeChatWorkflow.firstCall.args;
      expect(args[0]).to.eql('test prompt');
      expect(args[1]).to.deepEqual([]);
      expect(args[3]).to.be.undefined(); // no sessionId

      // transport.end() should be called
      const endCalls = (dummyResponse.end as sinon.SinonStub).getCalls();
      expect(endCalls.length).to.be.eql(1);
    });

    it('should handle error gracefully', async () => {
      const errorToThrow = new Error('Something went wrong!');
      runner.stubs.executeChatWorkflow.returns(
        throwingEventStream(errorToThrow),
      );

      await service.generate('test prompt', []).catch(err => {
        expect(err.message).to.be.eql('Something went wrong!');
      });

      // transport.end() should be called even on error
      const endCalls = (dummyResponse.end as sinon.SinonStub).getCalls();
      expect(endCalls.length).to.be.eql(1);
    });
  });

  describe('with HttpTransport', () => {
    beforeEach(() => {
      runner = createStubInstance(WorkflowRunner);
      dummyResponse = {
        write: sinon.stub(),
        end: sinon.stub(),
        status: sinon.stub(),
        setHeader: sinon.stub(),
      } as unknown as Response;
      dummyRequest = {
        once: sinon.stub(),
      } as unknown as Request;
      const transport = new HttpTransport(dummyResponse, dummyRequest);
      service = new GenerationService(runner, transport);
    });
    it('should handle generation request and return response', async () => {
      runner.stubs.executeChatWorkflow.returns(emptyEventStream());

      await service.generate('test prompt', []);

      expect(runner.stubs.executeChatWorkflow.calledOnce).to.be.true();
      const endCalls = (dummyResponse.end as sinon.SinonStub).getCalls();
      expect(endCalls.length).to.be.eql(1);
    });

    it('should handle error gracefully', async () => {
      const errorToThrow = new Error('Something went wrong!');
      runner.stubs.executeChatWorkflow.returns(
        throwingEventStream(errorToThrow),
      );

      await service.generate('test prompt', []).catch(err => {
        expect(err.message).to.be.eql('Something went wrong!');
      });

      const endCalls = (dummyResponse.end as sinon.SinonStub).getCalls();
      expect(endCalls.length).to.be.eql(1);
    });
  });
});
