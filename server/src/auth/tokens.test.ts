import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { env } from '../config/env.js';
import { extractBearerToken, signAccessToken, verifyAccessToken } from './tokens.js';
import { AppError } from '../errors/AppError.js';

/** Tier 1: pure functions, no database, no server. */

describe('signAccessToken / verifyAccessToken', () => {
  it('round-trips a user id', () => {
    expect(verifyAccessToken(signAccessToken('42'))).toBe('42');
  });

  it('issues a token that expires', () => {
    const decoded = jwt.decode(signAccessToken('42')) as { exp?: number; iat?: number };
    const sevenDays = 7 * 24 * 60 * 60;

    expect(decoded.exp).toBeDefined();
    expect(decoded.exp! - decoded.iat!).toBe(sevenDays);
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({}, 'a'.repeat(32), { subject: '42', algorithm: 'HS256' });
    expect(() => verifyAccessToken(forged)).toThrow(AppError);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({}, env.JWT_SECRET, {
      subject: '42',
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    expect(() => verifyAccessToken(expired)).toThrow(AppError);
  });

  it('rejects an unsigned token claiming alg: none', () => {
    // The algorithm-confusion attack the explicit `algorithms` option exists to
    // stop. Without that option the library honours the token's own header, and
    // this unsigned token would verify.
    const unsigned = jwt.sign({ sub: '42' }, '', { algorithm: 'none' });
    expect(() => verifyAccessToken(unsigned)).toThrow(AppError);
  });

  it('rejects a validly-signed token with no subject', () => {
    // Signature valid, payload wrong shape -- caught by the Zod check rather
    // than trusted because `jwt.verify` returned without throwing.
    const noSubject = jwt.sign({ something: 'else' }, env.JWT_SECRET, {
      algorithm: 'HS256',
    });
    expect(() => verifyAccessToken(noSubject)).toThrow(AppError);
  });

  it('reports every rejection as the same 401', () => {
    const forged = jwt.sign({}, 'a'.repeat(32), { subject: '42' });
    const error = (() => {
      try {
        verifyAccessToken(forged);
      } catch (e) {
        return e as AppError;
      }
      throw new Error('expected a throw');
    })();

    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
  });
});

describe('extractBearerToken', () => {
  it('reads a bearer token', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('accepts the scheme in any case, per RFC 7235', () => {
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER abc')).toBe('abc');
  });

  it('returns null for a missing, empty or non-bearer header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer   ')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('abc')).toBeNull();
  });
});
