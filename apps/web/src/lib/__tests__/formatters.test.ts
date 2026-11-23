import { describe, it, expect } from 'vitest';
import { formatUsd } from '../formatters';

describe('formatUsd', () => {
  it('formats negative values strictly as -$XX.XX', () => {
    expect(formatUsd(-107.7)).toBe('-$107.70');
    expect(formatUsd(-15.56)).toBe('-$15.56');
    expect(formatUsd(-15.56, true)).toBe('-$15.56');
    expect(formatUsd(-0.01)).toBe('-$0.01');
    expect(formatUsd(-1234.5)).toBe('-$1,234.50');
  });

  it('formats zero and near-zero values strictly as $0.00 even with showPlus=true', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0, true)).toBe('$0.00');
    expect(formatUsd(-0)).toBe('$0.00');
    expect(formatUsd(-0, true)).toBe('$0.00');
    expect(formatUsd(-0.001)).toBe('$0.00');
    expect(formatUsd(-0.001, true)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('$0.00');
    expect(formatUsd(0.004, true)).toBe('$0.00');
    expect(formatUsd(-0.0049)).toBe('$0.00');
    expect(formatUsd(-0.0049, true)).toBe('$0.00');
  });

  it('formats positive values with + only when showPlus=true', () => {
    expect(formatUsd(19.89)).toBe('$19.89');
    expect(formatUsd(19.89, false)).toBe('$19.89');
    expect(formatUsd(19.89, true)).toBe('+$19.89');
    expect(formatUsd(100)).toBe('$100.00');
    expect(formatUsd(100, true)).toBe('+$100.00');
    expect(formatUsd(1234567.89, true)).toBe('+$1,234,567.89');
  });

  it('returns $0.00 for non-finite inputs', () => {
    expect(formatUsd(NaN)).toBe('$0.00');
    expect(formatUsd(NaN, true)).toBe('$0.00');
    expect(formatUsd(Infinity)).toBe('$0.00');
    expect(formatUsd(Infinity, true)).toBe('$0.00');
    expect(formatUsd(-Infinity)).toBe('$0.00');
    expect(formatUsd(-Infinity, true)).toBe('$0.00');
    expect(formatUsd(null)).toBe('$0.00');
    expect(formatUsd(null, true)).toBe('$0.00');
    expect(formatUsd(undefined)).toBe('$0.00');
    expect(formatUsd(undefined, true)).toBe('$0.00');
  });
});
