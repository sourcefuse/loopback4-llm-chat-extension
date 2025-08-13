import {sinon} from '@loopback/testlab';
import {ILogger} from '@sourceloop/core';

export const loggerStub = () =>
  ({
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
  }) as unknown as ILogger;
