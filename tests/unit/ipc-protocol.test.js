/**
 * IPC wire-protocol tests — frame encode/decode, FrameParser stream behavior,
 * inline-payload size threshold helper.
 */
import { describe, it, expect } from 'vitest';
import {
  FRAME_KIND,
  DEGRADE_REASONS,
  encodeFrame,
  FrameParser,
  helloFrame,
  notifyFrame,
  ackFrame,
  pingFrame,
  pongFrame,
  degradeFrame,
  encodedNotifySize,
} from '../../lib/ipc-protocol.js';

describe('ipc-protocol — encode/decode round-trip', () => {
  it('encodes a hello frame as one newline-terminated JSON line', () => {
    const f = helloFrame({ subscriber_id: 'sub-1', cursor: 42, filter: { event_type: 'wicked.x.y' } });
    const line = encodeFrame(f);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n').length).toBe(2);                  // [json, '']
    expect(JSON.parse(line.trim())).toEqual({
      kind: FRAME_KIND.HELLO,
      subscriber_id: 'sub-1',
      cursor: 42,
      filter: { event_type: 'wicked.x.y' },
    });
  });

  it('rejects frames with unknown kind', () => {
    expect(() => encodeFrame({ kind: 'totally-bogus', x: 1 }))
      .toThrow(/unknown kind/);
  });

  it('rejects null / non-object input', () => {
    expect(() => encodeFrame(null)).toThrow();
    expect(() => encodeFrame('a string')).toThrow();
  });

  it('round-trips notify with inline payload', () => {
    const event = { event_id: 7, event_type: 'wicked.x.y', payload: '{"n":7}' };
    const f = notifyFrame({ event_id: 7, event });
    const parser = new FrameParser();
    const out = Array.from(parser.feed(encodeFrame(f)));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(f);
  });

  it('round-trips notify with null event (above-threshold pointer)', () => {
    const f = notifyFrame({ event_id: 99, event: null });
    const parser = new FrameParser();
    const out = Array.from(parser.feed(encodeFrame(f)));
    expect(out[0].event_id).toBe(99);
    expect(out[0].event).toBeNull();
  });

  it('round-trips ack, ping, pong, degrade', () => {
    for (const f of [
      ackFrame({ event_id: 1 }),
      pingFrame(),
      pongFrame(),
      degradeFrame({ reason: DEGRADE_REASONS.QUEUE_FULL }),
    ]) {
      const parser = new FrameParser();
      const [parsed] = Array.from(parser.feed(encodeFrame(f)));
      expect(parsed).toEqual(f);
    }
  });

  it('rejects degrade frames with an unknown reason', () => {
    expect(() => degradeFrame({ reason: 'bogus-reason' }))
      .toThrow(/unknown reason/);
  });
});

describe('FrameParser — chunk/boundary handling', () => {
  it('parses multiple frames from a single chunk', () => {
    const lines =
      encodeFrame(pingFrame()) +
      encodeFrame(ackFrame({ event_id: 1 })) +
      encodeFrame(ackFrame({ event_id: 2 }));
    const parser = new FrameParser();
    const frames = Array.from(parser.feed(lines));
    expect(frames).toHaveLength(3);
    expect(frames[0].kind).toBe(FRAME_KIND.PING);
    expect(frames[1].kind).toBe(FRAME_KIND.ACK);
    expect(frames[1].event_id).toBe(1);
    expect(frames[2].event_id).toBe(2);
  });

  it('buffers partial frames across feed() calls', () => {
    const fullLine = encodeFrame(ackFrame({ event_id: 42 }));
    const half = Math.floor(fullLine.length / 2);
    const parser = new FrameParser();

    // First chunk has no newline → no frames yet
    expect(Array.from(parser.feed(fullLine.slice(0, half)))).toEqual([]);
    expect(parser.hasPending()).toBe(true);

    // Second chunk completes the line
    const out = Array.from(parser.feed(fullLine.slice(half)));
    expect(out).toHaveLength(1);
    expect(out[0].event_id).toBe(42);
    expect(parser.hasPending()).toBe(false);
  });

  it('skips empty lines', () => {
    const parser = new FrameParser();
    const out = Array.from(parser.feed('\n\n' + encodeFrame(pingFrame()) + '\n'));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe(FRAME_KIND.PING);
  });

  it('throws on malformed JSON', () => {
    const parser = new FrameParser();
    expect(() => Array.from(parser.feed('this is not json\n')))
      .toThrow(/malformed frame/);
  });

  it('throws on JSON without a kind field', () => {
    const parser = new FrameParser();
    expect(() => Array.from(parser.feed('{"foo":"bar"}\n')))
      .toThrow(/missing kind/);
  });

  it('parses Buffer chunks (utf-8) correctly', () => {
    const parser = new FrameParser();
    const buf = Buffer.from(encodeFrame(pingFrame()), 'utf8');
    const out = Array.from(parser.feed(buf));
    expect(out).toHaveLength(1);
  });
});

describe('encodedNotifySize — inline-threshold helper', () => {
  it('returns the byte length of the encoded notify frame', () => {
    const event = { event_id: 1, event_type: 'wicked.x.y', payload: 'hi' };
    const size = encodedNotifySize(event);
    const expected = Buffer.byteLength(JSON.stringify(notifyFrame({ event_id: 1, event })));
    expect(size).toBe(expected);
  });

  it('grows roughly linearly with payload size (inline-threshold sanity)', () => {
    const small = encodedNotifySize({ event_id: 1, payload: 'x' });
    const big   = encodedNotifySize({ event_id: 1, payload: 'x'.repeat(10_000) });
    expect(big).toBeGreaterThan(small + 9_000);
  });
});
