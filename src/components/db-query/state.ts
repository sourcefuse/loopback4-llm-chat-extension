import {z} from 'zod';
import {ChangeType, DatabaseSchema, Status} from './types';
import {AnyObject} from '@loopback/repository';

/**
 * Permissive zod schema used as the Mastra workflow `stateSchema`. All fields
 * optional (so partial/initial states validate) with `catchall` to never strip.
 * `DbQueryState` below preserves the exact shape the nodes rely on.
 */
export const DbQueryGraphStateAnnotation = z
  .object({
    prompt: z.string().optional(),
    schema: z.custom<DatabaseSchema>().optional(),
    sql: z.string().optional(),
    status: z.custom<Status>().optional(),
    id: z.string().optional(),
    feedbacks: z.array(z.string()).optional(),
    replyToUser: z.string().optional(),
    datasetId: z.string().optional(),
    sampleSqlPrompt: z.string().optional(),
    sampleSql: z.string().optional(),
    fromCache: z.boolean().optional(),
    done: z.boolean().optional(),
    resultArray: z.array(z.any()).optional(),
    description: z.string().optional(),
    directCall: z.boolean().optional(),
    validationChecklist: z.string().optional(),
    syntacticStatus: z.custom<Status>().optional(),
    syntacticFeedback: z.string().optional(),
    semanticStatus: z.custom<Status>().optional(),
    semanticFeedback: z.string().optional(),
    syntacticErrorTables: z.array(z.string()).optional(),
    semanticErrorTables: z.array(z.string()).optional(),
    changeType: z.custom<ChangeType>().optional(),
    fromTemplate: z.boolean().optional(),
    templateId: z.string().optional(),
  })
  .catchall(z.any());

export type DbQueryState = {
  prompt: string;
  schema: DatabaseSchema;
  sql: string | undefined;
  status: Status | undefined;
  id: string | undefined;
  feedbacks: string[] | undefined;
  replyToUser: string | undefined;
  datasetId: string | undefined;
  sampleSqlPrompt: string | undefined;
  sampleSql: string | undefined;
  fromCache: boolean | undefined;
  done: boolean | undefined;
  resultArray: AnyObject[string][] | undefined;
  description: string | undefined;
  directCall: boolean | undefined;
  validationChecklist: string | undefined;
  syntacticStatus: Status | undefined;
  syntacticFeedback: string | undefined;
  semanticStatus: Status | undefined;
  semanticFeedback: string | undefined;
  syntacticErrorTables: string[] | undefined;
  semanticErrorTables: string[] | undefined;
  changeType: ChangeType | undefined;
  fromTemplate: boolean | undefined;
  templateId: string | undefined;
};
