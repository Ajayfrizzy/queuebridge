import { afterEach, describe, expect, it } from 'vitest';
import {
  discardRecoveryKey,
  fragmentParam,
  peekRecoveryKey,
  recoveryKeyText,
  recoveryLink,
  stashRecoveryKey,
} from './recoveryKey.js';

const KEY = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('recovery key handling in the browser', () => {
  afterEach(() => discardRecoveryKey());

  it('is held for the ticket it belongs to only, and can be discarded', () => {
    stashRecoveryKey({ code: 'A001', key: KEY, path: '/recover/o/f/A001' });
    expect(peekRecoveryKey('A001')?.key).toBe(KEY);
    // another ticket that merely shares a public code elsewhere never receives it by accident:
    // the page asks for ITS code and gets nothing for any other
    expect(peekRecoveryKey('A002')).toBeNull();
    discardRecoveryKey();
    expect(peekRecoveryKey('A001')).toBeNull();
  });

  it('is never written to web storage', () => {
    stashRecoveryKey({ code: 'A001', key: KEY, path: '' });
    expect(JSON.stringify({ ...localStorage })).not.toContain(KEY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(KEY);
  });

  it('the shareable link carries the key in the fragment only', () => {
    const link = recoveryLink('https://q.example', '/recover/o/f/A001', KEY);
    const url = new URL(link);
    expect(url.hash).toBe(`#k=${KEY}`);
    expect(url.pathname).toBe('/recover/o/f/A001');
    expect(url.search).toBe('');
    // a server only ever sees what precedes the fragment
    expect(link.split('#')[0]).not.toContain(KEY);
  });

  it('reads named fragment parameters and ignores the rest', () => {
    expect(fragmentParam(`#t=tok&k=${KEY}`, 'k')).toBe(KEY);
    expect(fragmentParam(`#t=tok&k=${KEY}`, 't')).toBe('tok');
    expect(fragmentParam('#g=abc', 'k')).toBeNull();
    expect(fragmentParam('', 'k')).toBeNull();
  });

  it('the saved file explains that the public code alone is not enough', () => {
    const text = recoveryKeyText('City Clinic', 'A001', KEY);
    expect(text).toContain('0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ');
    expect(text).toContain('ticket code alone cannot be used');
    expect(text).toContain('City Clinic');
  });
});
