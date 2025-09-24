import {Annotation} from '@langchain/langgraph';
import {DatabaseSchema, Status} from './types';
import {AnyObject} from '@loopback/repository';

export const DbQueryGraphStateAnnotation = Annotation.Root({
  prompt: Annotation<string>,
  schema: Annotation<DatabaseSchema>,
  sql: Annotation<string | undefined>,
  status: Annotation<Status | undefined>,
  id: Annotation<string | undefined>,
  feedbacks: Annotation<string[] | undefined>,
  replyToUser: Annotation<string | undefined>,
  datasetId: Annotation<string | undefined>,
  sampleSqlPrompt: Annotation<string | undefined>,
  sampleSql: Annotation<string | undefined>,
  fromCache: Annotation<boolean | undefined>,
  done: Annotation<boolean | undefined>,
  resultArray: Annotation<AnyObject[string][] | undefined>,
  description: Annotation<string | undefined>,
});

export type DbQueryState = typeof DbQueryGraphStateAnnotation.State;
