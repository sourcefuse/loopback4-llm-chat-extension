import {Annotation} from '@langchain/langgraph';
import {ChangeType, DatabaseSchema, Status} from './types';
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
  directCall: Annotation<boolean | undefined>,
  validationChecklist: Annotation<string | undefined>,
  syntacticStatus: Annotation<Status | undefined>,
  syntacticFeedback: Annotation<string | undefined>,
  semanticStatus: Annotation<Status | undefined>,
  semanticFeedback: Annotation<string | undefined>,
  syntacticErrorTables: Annotation<string[] | undefined>,
  semanticErrorTables: Annotation<string[] | undefined>,
  changeType: Annotation<ChangeType | undefined>,
  fromTemplate: Annotation<boolean | undefined>,
  templateId: Annotation<string | undefined>,
});

export type DbQueryState = typeof DbQueryGraphStateAnnotation.State;
