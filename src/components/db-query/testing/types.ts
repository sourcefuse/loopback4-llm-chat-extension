import {AnyObject} from '@loopback/repository';

export type GetTableNodeTestCase = {
  query: string;
  expectedTables: string[];
};

export type DbQueryGraphTestCase = {
  prompt: string;
  result: AnyObject[];
};

export type GenerationAcceptanceTestCase = {
  case: string;
  prompt: string;
  resultQuery: string;
  outputInstructions: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  only?: boolean;
  skip?: boolean;
  count?: number;
};

export type GenerationAcceptanceTestResult = {
  success: boolean;
  time: number;
  emptyOutput: boolean;
  inputTokens: number;
  outputTokens: number;
  generationCount: number;
  query: string;
  case: string;
  description: string;
  actualResult: AnyObject[] | null | string;
  expectedResult: AnyObject[] | null;
};

export type GenerationAcceptanceSuiteResult = {
  total: number;
  success: number;
  results: GenerationAcceptanceTestResult[];
};
