import {AnyObject} from '@loopback/repository';

export type GetTableNodeTestCase = {
  query: string;
  expectedTables: string[];
};

export type DbQueryGraphTestCase = {
  prompt: string;
  result: AnyObject[];
};
