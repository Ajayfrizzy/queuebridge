import { describe, expect, it } from 'vitest';
import { titleFor } from './routeFocus.js';

describe('document title follows the page heading (11.A2)', () => {
  it('uses "Heading — QueueBridge"', () => {
    expect(titleFor('Ticket G001')).toBe('Ticket G001 — QueueBridge');
  });
  it('collapses whitespace from nested heading markup', () => {
    expect(titleFor('  Ticket \n  G001 ')).toBe('Ticket G001 — QueueBridge');
  });
  it('falls back to the app name without a heading, and never repeats it', () => {
    expect(titleFor(null)).toBe('QueueBridge');
    expect(titleFor('')).toBe('QueueBridge');
    expect(titleFor('QueueBridge')).toBe('QueueBridge');
  });
});
