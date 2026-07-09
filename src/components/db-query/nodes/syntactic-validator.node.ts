import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../keys';
import {SqlValidatorService} from '../services/sql-validator.service';
import type {IDbConnector} from '../types';
import {emitToolStatus} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';
import type {SqlLoopState} from './sql-generation.node';

/**
 * Syntactic validation (DB EXPLAIN + read-only guard) — the Mastra successor of
 * the LangGraph `SyntacticValidatorNode`. Runs in parallel with the semantic
 * validator + description generator (the v2 PreValidation fan-out). Delegates
 * to the overridable `SqlValidatorService`; a host rebinds that service to
 * change the guard/validation policy.
 */
@graphNode(DbQueryNodes.SyntacticValidator)
export class SyntacticValidatorNode implements IGraphNode {
  constructor(
    @inject(DbQueryAIExtensionBindings.Connector, {optional: true})
    protected readonly dbConnector?: IDbConnector,
    @service(SqlValidatorService, {optional: true})
    protected readonly sqlValidator: SqlValidatorService = new SqlValidatorService(),
  ) {}

  async execute({inputData, requestContext}: GraphNodeCtx) {
    const data = inputData as SqlLoopState;
    if (data.skip === true || data.genError != null) {
      return {
        syntactic: {passed: data.genError == null, feedback: data.genError},
      };
    }
    emitToolStatus(
      requestContext,
      DbQueryNodes.SyntacticValidator,
      'Validating generated SQL query',
    );
    const verdict = await this.sqlValidator.validateSyntactic(
      data.sql ?? '',
      this.dbConnector,
    );
    return {syntactic: verdict};
  }
}
