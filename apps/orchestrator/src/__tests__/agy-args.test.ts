import { describe, expect, it } from 'vitest';
import { buildAgyArgs } from '../services/agy-args.js';

describe('buildAgyArgs', () => {
  const cases: Array<[string | undefined, string[]]> = [
    ['-p', ['-p', 'hi']],
    ['', ['-p', 'hi']],
    [undefined, ['-p', 'hi']],
    ['--dangerously-skip-permissions', ['--dangerously-skip-permissions', '-p', 'hi']],
    ['--dangerously-skip-permissions -p', ['--dangerously-skip-permissions', '-p', 'hi']],
    ['-p --print --dangerously-skip-permissions', ['--dangerously-skip-permissions', '-p', 'hi']],
  ];
  it.each(cases)('AGY_ARGS=%j', (input, expected) => {
    const args = buildAgyArgs(input, 'hi');
    expect(args).toEqual(expected);
    expect(args.filter((a) => a === '-p')).toHaveLength(1);
  });
});
