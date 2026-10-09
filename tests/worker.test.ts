import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { totpCode, base32Encode } from '../worker/auth';
import { jwt } from '../worker/enablebanking';

describe('Enable Banking JWT', () => {
  it('RS256 aláírás ellenőrizhető a nyilvános kulccsal', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = await jwt({ EB_APP_ID: 'app-123', EB_PRIVATE_KEY: pem } as any);
    const [h, p, sig] = token.split('.');
    const head = JSON.parse(Buffer.from(h, 'base64url').toString());
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(head).toEqual({ typ: 'JWT', alg: 'RS256', kid: 'app-123' });
    expect(body.iss).toBe('enablebanking.com');
    expect(body.aud).toBe('api.enablebanking.com');
    expect(body.exp - body.iat).toBeLessThanOrEqual(86400);
    const v = createVerify('RSA-SHA256');
    v.update(h + '.' + p);
    expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });
  it('PKCS#1 kulcsnál érthető hibát ad', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    await expect(jwt({ EB_APP_ID: 'a', EB_PRIVATE_KEY: pem } as any)).rejects.toThrow(/PKCS#8/);
  });
});

describe('TOTP', () => {
  it('RFC 6238 tesztvektor (SHA1, 59 s → 287082)', async () => {
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
    expect(await totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(await totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });
});
