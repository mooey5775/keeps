import { describe, expect, it } from 'vitest';
import { parseReplayLog } from '../src/index.ts';

describe('replay logs', () => {
  it('reject a log without an options line', () => {
    expect(() => parseReplayLog('{"seat":0,"command":{"type":"next-round"}}\n')).toThrow(/options/);
    expect(() => parseReplayLog('')).toThrow(/options/);
  });

  it('ignore blank lines', () => {
    const log = parseReplayLog('\n{"options":{"players":2,"seed":1}}\n\n{"seat":0,"command":{"type":"next-round"}}\n\n');
    expect(log.commands).toHaveLength(1);
  });
});
