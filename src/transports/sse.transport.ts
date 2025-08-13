import {BindingScope, inject, injectable} from '@loopback/core';
import {HttpErrors, Request, Response, RestBindings} from '@loopback/rest';
import {STATUS_CODE} from '@sourceloop/core';
import {LLMStreamEvent, LLMStreamEventType} from '../graphs/event.types';
import {ITransport} from './types';

const debug = require('debug')('ai-integration:log-events');
@injectable({scope: BindingScope.REQUEST})
export class SSETransport implements ITransport {
  constructor(
    @inject(RestBindings.Http.RESPONSE)
    private readonly response: Response,
    @inject(RestBindings.Http.REQUEST)
    private readonly req: Request,
  ) {}
  private _ended = false;
  async start() {
    this.response.setHeader('Content-Type', 'text/event-stream');
    this.response.setHeader('Cache-Control', 'no-cache');
    this.response.setHeader('Connection', 'keep-alive');
    this.response.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for Nginx
  }
  async send(message: LLMStreamEvent) {
    await this._handleChunk(message);
  }

  onCancel(cb: Function) {
    if (!this._ended) {
      this.req.once('close', () => {
        cb();
      });
    }
  }

  async end(err?: HttpErrors.HttpError) {
    this._ended = true;
    if (err) {
      this.response.write(
        `data: ${JSON.stringify({
          error: err,
        })}\n\n`,
      );
      this.response.status(err.statusCode || STATUS_CODE.INTERNAL_SERVER_ERROR);
      this.response.end();
    } else {
      this.response.status(STATUS_CODE.OK);
      this.response.end();
    }
  }

  private async _handleChunk(chunk: LLMStreamEvent) {
    if (chunk.type === LLMStreamEventType.Log) {
      debug('Log event:', chunk.data);
    } else {
      this.response.write(
        `data: ${JSON.stringify({
          type: chunk.type,
          data: chunk.data,
        })}\n\n`,
      );
    }
  }
}
