/**
 * giojs-core/src/ipc.test.ts
 *
 * Unit tests for IPC boundary validation and length-prefixed frame
 * reassembly, including the oversized-frame guard.
 */
import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  validateIPCRequest,
  makeFrameHandler,
  handshakeProof,
  MAX_IPC_MESSAGE_SIZE,
} from './ipc.ts';

function validFrame(): Record<string, unknown> {
  return {
    id: 'req-1',
    method: 'GET',
    path: '/posts/42',
    params: { id: '42' },
    query: { tab: 'comments' },
    headers: { accept: 'text/html' },
    body: null,
    deploymentId: 'deploy-abc',
    locale: 'en',
  };
}

describe('validateIPCRequest', () => {
  it('accepts a fully-formed request and preserves all fields', () => {
    const req = validateIPCRequest(validFrame());
    expect(req).not.toBeNull();
    expect(req?.id).toBe('req-1');
    expect(req?.method).toBe('GET');
    expect(req?.path).toBe('/posts/42');
    expect(req?.params['id']).toBe('42');
    expect(req?.query['tab']).toBe('comments');
    expect(req?.headers['accept']).toBe('text/html');
    expect(req?.body).toBeNull();
    expect(req?.deploymentId).toBe('deploy-abc');
    expect(req?.locale).toBe('en');
  });

  it('defaults missing deploymentId and locale to empty strings', () => {
    const frame = validFrame();
    delete frame['deploymentId'];
    delete frame['locale'];
    const req = validateIPCRequest(frame);
    expect(req?.deploymentId).toBe('');
    expect(req?.locale).toBe('');
  });

  it('normalizes an absent body to null', () => {
    const frame = validFrame();
    delete frame['body'];
    expect(validateIPCRequest(frame)?.body).toBeNull();
  });

  it('accepts the bodyBase64 flag and defaults it to false', () => {
    expect(validateIPCRequest(validFrame())?.bodyBase64).toBe(false);
    expect(validateIPCRequest({ ...validFrame(), bodyBase64: true })?.bodyBase64).toBe(true);
    expect(validateIPCRequest({ ...validFrame(), bodyBase64: 'yes' })).toBeNull();
  });

  it.each(['id', 'method', 'path', 'params', 'query', 'headers'])(
    'rejects a frame missing required field %s',
    (field) => {
      const frame = validFrame();
      delete frame[field];
      expect(validateIPCRequest(frame)).toBeNull();
    },
  );

  it('rejects wrongly-typed scalar fields', () => {
    expect(validateIPCRequest({ ...validFrame(), id: 42 })).toBeNull();
    expect(validateIPCRequest({ ...validFrame(), method: ['GET'] })).toBeNull();
    expect(validateIPCRequest({ ...validFrame(), path: {} })).toBeNull();
    expect(validateIPCRequest({ ...validFrame(), body: 123 })).toBeNull();
  });

  it('rejects params with non-string values', () => {
    expect(validateIPCRequest({ ...validFrame(), params: { id: 42 } })).toBeNull();
    expect(validateIPCRequest({ ...validFrame(), params: { id: null } })).toBeNull();
    expect(validateIPCRequest({ ...validFrame(), params: ['42'] })).toBeNull();
    expect(validateIPCRequest({ ...validFrame(), query: { nested: {} } })).toBeNull();
    expect(validateIPCRequest({ ...validFrame(), headers: { list: ['a'] } })).toBeNull();
  });
});

function encodeFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

describe('makeFrameHandler frame reassembly', () => {
  it('delivers a single frame arriving in one chunk', () => {
    const frames: string[] = [];
    const handler = makeFrameHandler(data => frames.push(data.toString('utf8')));
    handler(encodeFrame(Buffer.from('hello')));
    expect(frames).toEqual(['hello']);
  });

  it('reassembles a frame split across multiple chunks', () => {
    const frames: string[] = [];
    const handler = makeFrameHandler(data => frames.push(data.toString('utf8')));
    const wire = encodeFrame(Buffer.from('split-frame'));
    handler(wire.subarray(0, 7));
    expect(frames).toEqual([]);
    handler(wire.subarray(7));
    expect(frames).toEqual(['split-frame']);
  });

  it('delivers two frames packed into one chunk', () => {
    const frames: string[] = [];
    const handler = makeFrameHandler(data => frames.push(data.toString('utf8')));
    handler(Buffer.concat([encodeFrame(Buffer.from('first')), encodeFrame(Buffer.from('second'))]));
    expect(frames).toEqual(['first', 'second']);
  });

  it('handles the length prefix itself split across chunks', () => {
    const frames: string[] = [];
    const handler = makeFrameHandler(data => frames.push(data.toString('utf8')));
    const wire = encodeFrame(Buffer.from('prefix-split'));
    handler(wire.subarray(0, 2));
    expect(frames).toEqual([]);
    handler(wire.subarray(2, 4));
    expect(frames).toEqual([]);
    handler(wire.subarray(4));
    expect(frames).toEqual(['prefix-split']);
  });

  it('fires onOversize and stops delivering when the declared length exceeds the cap', () => {
    const frames: string[] = [];
    let oversizedLength: number | null = null;
    const handler = makeFrameHandler(data => frames.push(data.toString('utf8')), {
      maxFrameBytes: 16,
      onOversize: len => { oversizedLength = len; },
    });

    const header = Buffer.alloc(4);
    header.writeUInt32BE(17, 0);
    handler(header);

    expect(oversizedLength).toBe(17);
    expect(frames).toEqual([]);

    // Poisoned handler must ignore everything after the violation
    handler(encodeFrame(Buffer.from('after')));
    expect(frames).toEqual([]);
  });

  it('accepts a frame exactly at the cap boundary', () => {
    const frames: string[] = [];
    const handler = makeFrameHandler(data => frames.push(data.toString('utf8')), {
      maxFrameBytes: 5,
    });
    handler(encodeFrame(Buffer.from('12345')));
    expect(frames).toEqual(['12345']);
  });

  it('defaults the cap to MAX_IPC_MESSAGE_SIZE', () => {
    let oversizedLength: number | null = null;
    const handler = makeFrameHandler(() => undefined, {
      onOversize: len => { oversizedLength = len; },
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_IPC_MESSAGE_SIZE + 1, 0);
    handler(header);
    expect(oversizedLength).toBe(MAX_IPC_MESSAGE_SIZE + 1);
  });
});

describe('handshakeProof', () => {
  // Pinned vector shared with crates/giojs-server/src/ipc.rs - both sides
  // must derive identical proofs or the handshake always fails.
  it('matches the Rust known vector', () => {
    expect(handshakeProof('secret', 'ready')).toBe(
      'b2c1f253f21f3cb7e2c446b50a4026ec87a8f4010a4e0c3716cd1b0d7f48be0d',
    );
  });

  it('derives distinct proofs per role and token', () => {
    expect(handshakeProof('secret', 'ready')).not.toBe(handshakeProof('secret', 'ack'));
    expect(handshakeProof('secret', 'ack')).not.toBe(handshakeProof('secret', 'ws'));
    expect(handshakeProof('secret', 'ready')).not.toBe(handshakeProof('other', 'ready'));
  });
});
