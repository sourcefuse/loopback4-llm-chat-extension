import {expect} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {EvaluationResult} from '../../../../components/db-query/types';
import {mergeValidationResults} from '../../../../mastra/db-query/workflow/steps/post-validation.step';

describe('mergeValidationResults (Mastra)', function () {
  it('returns Pass and clears per-round fields when both validators pass', () => {
    const state = {
      syntacticStatus: EvaluationResult.Pass,
      semanticStatus: EvaluationResult.Pass,
      feedbacks: ['old feedback'],
    } as unknown as DbQueryState;

    const result = mergeValidationResults(state);

    expect(result.status).to.equal(EvaluationResult.Pass);
    expect(result.syntacticStatus).to.be.undefined();
    expect(result.semanticStatus).to.be.undefined();
    expect(result.syntacticFeedback).to.be.undefined();
    expect(result.semanticFeedback).to.be.undefined();
  });

  it('clears "Query Validation Failed" feedbacks on pass', () => {
    const state = {
      syntacticStatus: EvaluationResult.Pass,
      semanticStatus: EvaluationResult.Pass,
      feedbacks: ['Query Validation Failed: syntax error', 'other feedback'],
    } as unknown as DbQueryState;

    const result = mergeValidationResults(state);

    expect(result.feedbacks).to.not.containEql(
      'Query Validation Failed: syntax error',
    );
    expect(result.feedbacks).to.containEql('other feedback');
  });

  it('uses syntactic status when syntactic validator fails', () => {
    const state = {
      syntacticStatus: 'query_error',
      syntacticFeedback: 'Query Validation Failed: bad syntax',
      feedbacks: [],
    } as unknown as DbQueryState;

    const result = mergeValidationResults(state);

    expect(result.status).to.equal('query_error');
    expect(result.feedbacks).to.containEql(
      'Query Validation Failed: bad syntax',
    );
  });

  it('uses semantic status when only semantic validator fails', () => {
    const state = {
      syntacticStatus: EvaluationResult.Pass,
      semanticStatus: 'wrong_result',
      semanticFeedback: 'Data does not match expected output',
      feedbacks: [],
    } as unknown as DbQueryState;

    const result = mergeValidationResults(state);

    expect(result.status).to.equal('wrong_result');
    expect(result.feedbacks).to.containEql(
      'Data does not match expected output',
    );
  });

  it('prefers syntactic over semantic when both fail', () => {
    const state = {
      syntacticStatus: 'query_error',
      syntacticFeedback: 'Syntactic issue',
      semanticStatus: 'wrong_result',
      semanticFeedback: 'Semantic issue',
      feedbacks: [],
    } as unknown as DbQueryState;

    const result = mergeValidationResults(state);

    expect(result.status).to.equal('query_error');
    expect(result.feedbacks).to.containEql('Syntactic issue');
    expect(result.feedbacks).to.containEql('Semantic issue');
  });

  it('accumulates feedbacks from previous rounds', () => {
    const state = {
      syntacticStatus: 'query_error',
      syntacticFeedback: 'New error',
      feedbacks: ['Previous round error'],
    } as unknown as DbQueryState;

    const result = mergeValidationResults(state);

    expect(result.feedbacks).to.containEql('Previous round error');
    expect(result.feedbacks).to.containEql('New error');
  });

  it('merges errorTables from both validators', () => {
    const state = {
      syntacticStatus: 'query_error',
      syntacticErrorTables: ['employees'],
      semanticErrorTables: ['departments'],
      feedbacks: [],
    } as unknown as DbQueryState;

    const result = mergeValidationResults(state);

    expect(result.syntacticErrorTables).to.containDeep([
      'employees',
      'departments',
    ]);
    expect(result.semanticErrorTables).to.containDeep([
      'employees',
      'departments',
    ]);
  });

  it('handles state with no validators run (both undefined)', () => {
    const state = {feedbacks: []} as unknown as DbQueryState;
    const result = mergeValidationResults(state);

    // Both undefined → treated as pass
    expect(result.status).to.equal(EvaluationResult.Pass);
  });
});
