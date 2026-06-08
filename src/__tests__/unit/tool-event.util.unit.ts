import {expect} from '@loopback/testlab';
import {
  asEventWriter,
  asRecord,
  pickBranchOutput,
  readString,
} from '../../graphs/tool-event.util';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';

/**
 * Coercion helpers shared by every Mastra tool wrapper. They sit on the
 * boundary between Mastra's loosely-typed `ToolExecutionContext` and the
 * SSE event pipeline, so a regression here silently corrupts every
 * tool's UI events (datasetId dropped, eventWriter swallowed, branch
 * unwrap picking the wrong arm). Lock the contract.
 */
describe('graphs/tool-event.util (unit)', () => {
  describe('asRecord', () => {
    it('returns the input when it is a plain object', () => {
      const input = {a: 1, b: 'two'};
      expect(asRecord(input)).to.equal(input);
    });

    it('returns an empty object for non-objects (string, number, boolean)', () => {
      expect(asRecord('x')).to.eql({});
      expect(asRecord(7)).to.eql({});
      expect(asRecord(true)).to.eql({});
    });

    it('returns an empty object for null and undefined', () => {
      // `typeof null === 'object'` — guard would leak through without
      // the explicit null check, so this regression matters.
      expect(asRecord(null)).to.eql({});
      expect(asRecord(undefined)).to.eql({});
    });

    it('passes arrays through (typeof [] === "object")', () => {
      // The helper is intentionally a thin object-ness check, not a
      // plain-object guard. Mastra never returns arrays where a record
      // is expected, so this is documented behaviour rather than a bug
      // — the test is here so anyone who tightens the predicate to
      // reject arrays does so deliberately and updates the contract.
      const arr = [1, 2, 3];
      expect(asRecord(arr)).to.equal(arr);
    });
  });

  describe('readString', () => {
    it('returns string values unchanged', () => {
      expect(readString('ds-42')).to.equal('ds-42');
      expect(readString('')).to.equal('');
    });

    it('returns undefined for non-string values (number, boolean, object)', () => {
      // DB autoincrement ids arrive as numbers — the tool layer expects
      // a string and would otherwise pass a number to the UI.
      expect(readString(42)).to.be.undefined();
      expect(readString(true)).to.be.undefined();
      expect(readString({datasetId: 'x'})).to.be.undefined();
      expect(readString(null)).to.be.undefined();
      expect(readString(undefined)).to.be.undefined();
    });
  });

  describe('asEventWriter', () => {
    it('returns the writer function when it is callable', () => {
      const writer = (_e: LLMStreamEvent) => {};
      expect(asEventWriter(writer)).to.equal(writer);
    });

    it('returns undefined when the value is not a function', () => {
      expect(asEventWriter(undefined)).to.be.undefined();
      expect(asEventWriter(null)).to.be.undefined();
      expect(asEventWriter({})).to.be.undefined();
      expect(asEventWriter('writer')).to.be.undefined();
    });

    it('the returned writer accepts an LLMStreamEvent without throwing', () => {
      const received: LLMStreamEvent[] = [];
      const writer = asEventWriter((e: LLMStreamEvent) => received.push(e));
      writer?.({
        type: LLMStreamEventType.Status,
        data: 'hello',
      });
      expect(received).to.have.length(1);
      expect(received[0].type).to.equal(LLMStreamEventType.Status);
    });
  });

  describe('pickBranchOutput', () => {
    it('returns the save arm when it has keys (success branch)', () => {
      const save = {datasetId: 'ds-1', sql: 'SELECT 1'};
      expect(pickBranchOutput(save, {}, {ignored: true})).to.equal(save);
    });

    it('returns the failed arm when only it has keys', () => {
      const failed = {datasetId: ''};
      expect(pickBranchOutput({}, failed, {ignored: true})).to.equal(failed);
    });

    it('returns the raw result when neither branch arm matched', () => {
      // Direct .then(step) workflows (no .branch) land their result on
      // the root — without this fallback every flat workflow would
      // drop its output.
      const raw = {datasetId: 'raw-1', sql: 'SELECT 2'};
      expect(pickBranchOutput({}, {}, raw)).to.equal(raw);
    });

    it('save arm wins over failed arm when both happen to have keys', () => {
      // Defensive — Mastra should never emit both, but the precedence
      // here is what the tool layer assumes when extracting datasetId.
      const save = {datasetId: 'ds-1'};
      const failed = {datasetId: ''};
      expect(pickBranchOutput(save, failed, {})).to.equal(save);
    });
  });
});
