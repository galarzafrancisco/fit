import { randomBytes } from 'node:crypto';
import { scrubPayload } from '../activities/activity-ingest.service';
import { escapeHtml } from '../connections/connect-callback.controller';
import { TokenCipher, safeEqual } from './secrets';

describe('TokenCipher', () => {
  const cipher = new TokenCipher(randomBytes(32));

  it('round-trips and binds the ciphertext to its row', () => {
    const sealed = cipher.encrypt('access-token', 'row-1');
    expect(sealed).not.toContain('access-token');
    expect(cipher.decrypt(sealed, 'row-1')).toBe('access-token');
    expect(() => cipher.decrypt(sealed, 'row-2')).toThrow();
    expect(() => new TokenCipher(randomBytes(32)).decrypt(sealed, 'row-1')).toThrow();
  });

  it('uses a fresh IV each time', () => {
    expect(cipher.encrypt('x', 'r')).not.toBe(cipher.encrypt('x', 'r'));
  });
});

describe('small helpers', () => {
  it('compares secrets in constant time and handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('escapes HTML on the callback page', () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
  });

  it('removes token fields from stored provider payloads', () => {
    expect(scrubPayload({ id: 1, userAccessToken: 't', access_token: 'a', refresh_token: 'r' })).toEqual({ id: 1 });
    expect(scrubPayload(null)).toEqual({});
  });
});
