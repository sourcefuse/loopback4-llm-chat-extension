import {IterableReadableStream} from '@langchain/core/utils/stream';
import {Request, Response} from '@loopback/rest';
import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab';
import {PassThrough} from 'stream';
import {ChatGraph, LLMStreamEvent} from '../../graphs';
import {GenerationService} from '../../services';
import {HttpTransport, SSETransport} from '../../transports';

describe(`GenerationService Integration`, () => {
  let service: GenerationService;
  let dummyRequest: Request;
  let dummyResponse: Response;
  let graph: StubbedInstanceWithSinonAccessor<ChatGraph>;

  describe('with SSETransport', () => {
    beforeEach(() => {
      graph = createStubInstance(ChatGraph);
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
      service = new GenerationService(graph, transport);
    });
    it('should handle generation request and return response', async () => {
      const dummyStream = new PassThrough({objectMode: true});
      graph.stubs.execute.callsFake(async () => {
        return dummyStream as unknown as IterableReadableStream<LLMStreamEvent>;
      });
      dummyStream.push({
        type: 'text',
        data: 'This is a response from LLM',
      });
      dummyStream.push({
        type: 'text',
        data: 'This is a second response from LLM',
      });
      setTimeout(() => {
        dummyStream.end();
      }, 10);
      await service.generate('test prompt', []);

      const writeCalls = (dummyResponse.write as sinon.SinonStub).getCalls();
      const setHeaderCalls = (
        dummyResponse.setHeader as sinon.SinonStub
      ).getCalls();
      const statusCalls = (dummyResponse.status as sinon.SinonStub).getCalls();
      const endCalls = (dummyResponse.end as sinon.SinonStub).getCalls();
      expect(writeCalls.length).to.be.eql(2);
      expect(writeCalls[0].args[0]).to.deepEqual(
        `data: ${JSON.stringify({
          type: 'text',
          data: 'This is a response from LLM',
        })}\n\n`,
      );
      expect(writeCalls[1].args[0]).to.deepEqual(
        `data: ${JSON.stringify({
          type: 'text',
          data: 'This is a second response from LLM',
        })}\n\n`,
      );
      expect(setHeaderCalls.length).to.be.eql(4);
      expect(setHeaderCalls[0].args[0]).to.be.eql('Content-Type');
      expect(setHeaderCalls[0].args[1]).to.be.eql('text/event-stream');
      expect(setHeaderCalls[1].args[0]).to.be.eql('Cache-Control');
      expect(setHeaderCalls[1].args[1]).to.be.eql('no-cache');
      expect(setHeaderCalls[2].args[0]).to.be.eql('Connection');
      expect(setHeaderCalls[2].args[1]).to.be.eql('keep-alive');
      expect(setHeaderCalls[3].args[0]).to.be.eql('X-Accel-Buffering');
      expect(setHeaderCalls[3].args[1]).to.be.eql('no'); // Disable buffering for Nginx

      expect(statusCalls.length).to.be.eql(1);
      expect(statusCalls[0].args[0]).to.be.eql(200);

      expect(endCalls.length).to.be.eql(1);
    });

    it('should handle error gracyfully', async () => {
      const dummyStream = new PassThrough({objectMode: true});
      graph.stubs.execute.callsFake(async () => {
        return dummyStream as unknown as IterableReadableStream<LLMStreamEvent>;
      });
      dummyStream.push({
        type: 'text',
        data: 'This is a response from LLM',
      });
      const errorToThrow = new Error('Something went wrong!');
      setTimeout(() => {
        dummyStream.destroy(errorToThrow);
      }, 100);
      await service.generate('test prompt', []).catch(err => {
        expect(err.message).to.be.eql('Something went wrong!');
      });
      const writeCalls = (dummyResponse.write as sinon.SinonStub).getCalls();
      const setHeaderCalls = (
        dummyResponse.setHeader as sinon.SinonStub
      ).getCalls();
      const statusCalls = (dummyResponse.status as sinon.SinonStub).getCalls();
      const endCalls = (dummyResponse.end as sinon.SinonStub).getCalls();
      expect(writeCalls.length).to.be.eql(2);
      expect(writeCalls[0].args[0]).to.deepEqual(
        `data: ${JSON.stringify({
          type: 'text',
          data: 'This is a response from LLM',
        })}\n\n`,
      );

      expect(writeCalls[1].args[0]).to.deepEqual(
        `data: ${JSON.stringify({
          error: errorToThrow,
        })}\n\n`,
      );
      expect(setHeaderCalls.length).to.be.eql(4);
      expect(setHeaderCalls[0].args[0]).to.be.eql('Content-Type');
      expect(setHeaderCalls[0].args[1]).to.be.eql('text/event-stream');
      expect(setHeaderCalls[1].args[0]).to.be.eql('Cache-Control');
      expect(setHeaderCalls[1].args[1]).to.be.eql('no-cache');
      expect(setHeaderCalls[2].args[0]).to.be.eql('Connection');
      expect(setHeaderCalls[2].args[1]).to.be.eql('keep-alive');
      expect(setHeaderCalls[3].args[0]).to.be.eql('X-Accel-Buffering');
      expect(setHeaderCalls[3].args[1]).to.be.eql('no'); // Disable buffering for Nginx

      expect(statusCalls.length).to.be.eql(1);
      expect(statusCalls[0].args[0]).to.be.eql(500);

      expect(endCalls.length).to.be.eql(1);
    });
  });

  describe('with HttpTransport', () => {
    beforeEach(() => {
      graph = createStubInstance(ChatGraph);
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
      service = new GenerationService(graph, transport);
    });
    it('should handle generation request and return response', async () => {
      const dummyStream = new PassThrough({objectMode: true});
      graph.stubs.execute.callsFake(async () => {
        return dummyStream as unknown as IterableReadableStream<LLMStreamEvent>;
      });
      dummyStream.push({
        type: 'text',
        data: 'This is a response from LLM',
      });
      dummyStream.push({
        type: 'text',
        data: 'This is a second response from LLM',
      });
      setTimeout(() => {
        dummyStream.end();
      }, 10);
      await service.generate('test prompt', []);

      const writeCalls = (dummyResponse.write as sinon.SinonStub).getCalls();
      const setHeaderCalls = (
        dummyResponse.setHeader as sinon.SinonStub
      ).getCalls();
      const statusCalls = (dummyResponse.status as sinon.SinonStub).getCalls();
      const endCalls = (dummyResponse.end as sinon.SinonStub).getCalls();
      expect(writeCalls.length).to.be.eql(1);
      expect(writeCalls[0].args[0]).to.deepEqual(
        `${JSON.stringify([
          {
            type: 'text',
            data: 'This is a response from LLM',
          },
          {
            type: 'text',
            data: 'This is a second response from LLM',
          },
        ])}`,
      );
      expect(setHeaderCalls.length).to.be.eql(1);
      expect(setHeaderCalls[0].args[0]).to.be.eql('Content-Type');
      expect(setHeaderCalls[0].args[1]).to.be.eql('application/json');

      expect(statusCalls.length).to.be.eql(1);
      expect(statusCalls[0].args[0]).to.be.eql(200);

      expect(endCalls.length).to.be.eql(1);
    });

    it('should handle error gracyfully', async () => {
      const dummyStream = new PassThrough({objectMode: true});
      graph.stubs.execute.callsFake(async () => {
        return dummyStream as unknown as IterableReadableStream<LLMStreamEvent>;
      });
      dummyStream.push({
        type: 'text',
        data: 'This is a response from LLM',
      });
      const errorToThrow = new Error('Something went wrong!');
      setTimeout(() => {
        dummyStream.destroy(errorToThrow);
      }, 100);
      await service.generate('test prompt', []).catch(err => {
        expect(err.message).to.be.eql('Something went wrong!');
      });
      const writeCalls = (dummyResponse.write as sinon.SinonStub).getCalls();
      const setHeaderCalls = (
        dummyResponse.setHeader as sinon.SinonStub
      ).getCalls();
      const statusCalls = (dummyResponse.status as sinon.SinonStub).getCalls();
      const endCalls = (dummyResponse.end as sinon.SinonStub).getCalls();
      expect(writeCalls.length).to.be.eql(1);

      expect(writeCalls[0].args[0]).to.deepEqual(
        `${JSON.stringify({
          error: errorToThrow,
        })}`,
      );
      expect(setHeaderCalls.length).to.be.eql(1);
      expect(setHeaderCalls[0].args[0]).to.be.eql('Content-Type');
      expect(setHeaderCalls[0].args[1]).to.be.eql('application/json');

      expect(statusCalls.length).to.be.eql(1);
      expect(statusCalls[0].args[0]).to.be.eql(500);

      expect(endCalls.length).to.be.eql(1);
    });
  });
});
