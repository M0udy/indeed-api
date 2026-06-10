import type { Request, Response } from 'express';
import type { ValidatedLocals } from '../src/middleware/validate';

/** A test double for an Express Response that records status() and json(). */
export interface MockResponse extends Response {
  _status: number;
  _json: unknown;
}

/** Build a minimal Response stub that captures what the handler sends. */
export function mockResponse(locals: ValidatedLocals = {}): MockResponse {
  const res = {
    locals,
    _status: 200,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as MockResponse;
}

/** Build a minimal Request stub. */
export function mockRequest(overrides: Partial<Request> = {}): Request {
  return { params: {}, query: {}, headers: {}, body: {}, ...overrides } as Request;
}
