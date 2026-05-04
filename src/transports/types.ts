import {AnyObject} from '@loopback/repository';
import {LLMStreamEvent} from '../types/events';

export interface ITransport {
  start(): Promise<void>;
  send(message: LLMStreamEvent): Promise<void>;
  end(err?: Error): Promise<void>;
  onCancel(cb: (...args: AnyObject[]) => void): void;
}
