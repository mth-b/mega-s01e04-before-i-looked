import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';

const night = '2026-10-28';
const event = { at: '2026-10-28T23:00:00+01:00', job: 'job', status: 'ok', owner: 'rook' };
let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-reader-'));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function writeEvents(events: unknown[]): void {
  writeFileSync(join(runsDir, `${night}.jsonl`), events.map((value) => JSON.stringify(value)).join('\n'));
}

describe('readNight', () => {
  it('reads the real Oct 28 fixture without changing it', () => {
    const result = readNight(fileURLToPath(new URL('../runs/', import.meta.url)), night);
    expect(result).toEqual({
      night, badLines: 1, counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        { job: 'digest/render', owner: null, runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00', hasFailure: false },
        { job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00', hasFailure: false },
        { job: 'lane/sync', owner: 'rook', runs: 8, retries: 1, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00', hasFailure: false },
        { job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0, lastStatus: 'fail', lastError: 'quota exceeded',
          firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00', hasFailure: true },
        { job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00', hasFailure: false },
      ],
    });
  });

  it('orders events chronologically across offsets, clears errors, and retains any failure', () => {
    writeEvents([
      { ...event, at: '2026-10-29T00:15:00+02:00', status: 'retry', error: 'retrying' },
      { ...event, at: '2026-10-28T23:30:00+01:00', owner: null },
      { ...event, at: '2026-10-28T22:00:00Z', status: 'fail', error: 'failed', owner: 'earliest' },
    ]);
    expect(readNight(runsDir, night)).toEqual({
      night, badLines: 0, counts: { ok: 1, retry: 1, fail: 1 },
      rows: [{ job: 'job', owner: null, runs: 3, retries: 1, lastStatus: 'ok', lastError: null,
        firstAt: '2026-10-28T22:00:00Z', lastAt: '2026-10-28T23:30:00+01:00', hasFailure: true }],
    });
  });

  it('takes status, owner, and error from the latest event, using later lines for ties', () => {
    writeEvents([
      event,
      { ...event, at: '2026-10-29T01:00:00+01:00', status: 'fail', error: 'latest', owner: 'new' },
      { ...event, status: 'retry', error: 'older' },
      { ...event, at: '2026-10-29T01:00:00+01:00', status: 'retry', error: 'tied', owner: null },
    ]);
    expect(readNight(runsDir, night)?.rows[0]).toMatchObject({
      runs: 4, retries: 2, lastStatus: 'retry', lastError: 'tied', owner: null, hasFailure: true,
    });
  });

  it('counts malformed JSON and invalid fields, ignoring blank lines', () => {
    const invalid = [
      null, [], 4, 'text', {},
      { ...event, at: null }, { ...event, at: 'not a date' },
      { ...event, at: '2026-02-30T01:00:00Z' }, { ...event, at: '2026-10-28T24:00:00Z' },
      { ...event, at: '2026-10-28T23:60:00Z' }, { ...event, at: '2026-10-28T23:00:60Z' },
      { ...event, at: '2026-10-28T23:00:00+24:00' }, { ...event, at: '2026-10-28T23:00:00+01:60' },
      { ...event, at: '2026-10-28T23:00:00' }, { ...event, at: `${event.at}\n` },
      { ...event, job: null }, { ...event, job: '' }, { ...event, job: '  ' },
      { ...event, status: 'unknown' }, { ...event, status: null },
      { ...event, owner: 1 }, { ...event, owner: undefined },
      { ...event, error: 1 }, { ...event, error: null },
    ];
    writeFileSync(join(runsDir, `${night}.jsonl`),
      `${invalid.map((value) => JSON.stringify(value)).join('\r\n')}\r\n{bad json\n\n \t\r\n${JSON.stringify({ ...event, owner: null })}\n`);
    expect(readNight(runsDir, night)).toEqual({
      night, badLines: invalid.length + 1, counts: { ok: 1, retry: 0, fail: 0 },
      rows: [{ job: 'job', owner: null, runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
        firstAt: event.at, lastAt: event.at, hasFailure: false }],
    });
  });

  it('sorts jobs consistently and does not treat object property names specially', () => {
    writeEvents(['z', '__proto__', 'a', 'constructor', 'A'].map((job) => ({ ...event, job })));
    expect(readNight(runsDir, night)?.rows.map((row) => row.job)).toEqual(['A', '__proto__', 'a', 'constructor', 'z']);
  });

  it('returns null for a missing file or missing directory', () => {
    expect(readNight(runsDir, night)).toBeNull();
    expect(readNight(join(runsDir, 'missing'), night)).toBeNull();
  });

  it.each(['', '\n \t\r\n'])('returns an empty digest for empty or blank-only files', (contents) => {
    writeFileSync(join(runsDir, `${night}.jsonl`), contents);
    expect(readNight(runsDir, night)).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('returns a digest for an all-invalid file', () => {
    writeEvents([null]);
    expect(readNight(runsDir, night)).toEqual({ night, rows: [], badLines: 1, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it.each(['../2026-10-28', '/2026-10-28', '..\\2026-10-28', '2026-10-28/..',
    '2026-10-28\n', '2026-10-28\0', '2026-1-28', '2026-02-29', '2026-02-30',
    '2026-13-01', '2026-00-01', '2026-10-00', '2026-10-32', '1900-02-29'])
  ('rejects invalid or traversal nights: %s', (invalidNight) => {
    expect(readNight(runsDir, invalidNight)).toBeNull();
  });

  it.each(['2024-02-29', '2000-02-29'])('accepts real leap days: %s', (leapNight) => {
    writeFileSync(join(runsDir, `${leapNight}.jsonl`), '');
    expect(readNight(runsDir, leapNight)?.night).toBe(leapNight);
  });

  it('rethrows non-missing filesystem errors', () => {
    mkdirSync(join(runsDir, `${night}.jsonl`));
    expect(() => readNight(runsDir, night)).toThrow();
    const file = join(runsDir, 'not-a-directory');
    writeFileSync(file, '');
    expect(() => readNight(file, night)).toThrow();
  });
});
