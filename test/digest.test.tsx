import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { DigestResult } from '../src/digest/types.js';

const night = '2026-10-28';
const firstAt = '2026-10-28T23:00:00+02:00';
const lastAt = '2026-10-29T01:00:00-04:00';
const event = { at: firstAt, job: 'alpha/job', status: 'ok', owner: null };
let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-'));
  vi.stubEnv('LANE_ID', 'digest-test-lane');
  vi.stubEnv('LANE_MARKER', 'digest-test-marker');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(runsDir, { recursive: true, force: true });
});

function writeEvents(events: unknown[]): void {
  writeFileSync(join(runsDir, `${night}.jsonl`), events.map((value) => JSON.stringify(value)).join('\n'));
}

function app() {
  return createApp({ adapter: 'shim', installed: firstAt, beatEverySeconds: 60, runsDir });
}

function tableRows(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .filter((match) => /<td\b/i.test(match[1]))
    .map((match) => match[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

describe('digest routes', () => {
  it('renders the layout and the same sorted job summaries as JSON, preserving offsets and null owners', async () => {
    writeEvents([
      { ...event, job: 'zeta/job', status: 'fail', owner: 'rook', error: 'quota exceeded' },
      { ...event, at: lastAt },
      { ...event, status: 'fail', error: 'earlier failure' },
      ...['23:01:00', '23:02:00', '23:03:00'].map((time) => ({
        ...event, at: `2026-10-28T${time}+02:00`, status: 'retry', error: 'retrying',
      })),
    ]);
    const instance = app();
    const htmlResponse = await instance.request(`/digest/${night}`);
    const jsonResponse = await instance.request(`/api/digest/${night}`);
    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(htmlResponse.headers.get('content-type')).toMatch(/^text\/html\b/);
    expect(jsonResponse.headers.get('content-type')).toMatch(/^application\/json\b/);
    const result: DigestResult = await jsonResponse.json();
    expect(result).toEqual({
      night, badLines: 0, counts: { ok: 1, retry: 3, fail: 2 },
      rows: [
        { job: 'alpha/job', owner: null, runs: 5, retries: 3, lastStatus: 'ok', lastError: null,
          firstAt, lastAt, hasFailure: true },
        { job: 'zeta/job', owner: 'rook', runs: 1, retries: 0, lastStatus: 'fail', lastError: 'quota exceeded',
          firstAt, lastAt: firstAt, hasFailure: true },
      ],
    });
    const html = await htmlResponse.text();
    expect(html).toContain('digest-test-lane');
    expect(html).toContain('digest-test-marker');
    expect(html).toMatch(/<style\b/i);
    expect(html).not.toMatch(/<script\b/i);
    const rows = tableRows(html);
    expect(rows).toHaveLength(result.rows.length);
    expect(rows.map((text) => result.rows.find((row) => text.includes(row.job))?.job))
      .toEqual(result.rows.map((row) => row.job));
    for (const [index, row] of result.rows.entries()) {
      for (const value of [row.job, row.owner ?? '\u2014', row.lastStatus, row.lastError ?? '\u2014', row.firstAt, row.lastAt]) {
        expect(rows[index]).toContain(value);
      }
      expect(rows[index]).toMatch(new RegExp(`\\b${row.runs}\\b`));
      expect(rows[index]).toMatch(new RegExp(`\\b${row.retries}\\b`));
    }
    expect(html).not.toContain('earlier failure');
    expect(html).not.toContain('retrying');
  });

  it.each(['/digest', '/api/digest'])('returns 404 for a missing night through %s', async (route) => {
    expect((await app().request(`${route}/${night}`)).status).toBe(404);
  });

  it.each(['not-a-night', '2026-1-28', '2026-02-30', '2026-13-01', '..%2F2026-10-28'])
  ('returns 404 from both routes for an invalid night: %s', async (invalidNight) => {
    writeEvents([event]);
    // A file with an invalid calendar name must not turn invalid input into a successful response.
    writeFileSync(join(runsDir, '2026-02-30.jsonl'), JSON.stringify(event));
    const instance = app();
    for (const route of ['/digest', '/api/digest']) {
      expect((await instance.request(`${route}/${invalidNight}`)).status).toBe(404);
    }
  });

  it.each(['', '\n \t\r\n'])('returns 200 and nothing ran for an empty night: %j', async (contents) => {
    writeFileSync(join(runsDir, `${night}.jsonl`), contents);
    const instance = app();
    const htmlResponse = await instance.request(`/digest/${night}`);
    const jsonResponse = await instance.request(`/api/digest/${night}`);
    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toMatch(/nothing ran/i);
    expect(await jsonResponse.json()).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('keeps valid rows and reports malformed lines without counting blank lines', async () => {
    writeFileSync(join(runsDir, `${night}.jsonl`),
      `${JSON.stringify(event)}\n{bad json\n${JSON.stringify({ ...event, status: 'unknown' })}\n\n \t\r\n`);
    const instance = app();
    const htmlResponse = await instance.request(`/digest/${night}`);
    const jsonResponse = await instance.request(`/api/digest/${night}`);
    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(await jsonResponse.json()).toEqual({
      night, badLines: 2, counts: { ok: 1, retry: 0, fail: 0 },
      rows: [{ job: event.job, owner: null, runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
        firstAt, lastAt: firstAt, hasFailure: false }],
    });
    const html = await htmlResponse.text();
    expect(tableRows(html)).toHaveLength(1);
    expect(html).toContain(event.job);
    expect(html.replace(/<[^>]*>/g, ' '))
      .toMatch(/(?:2\s+(?:bad|malformed|invalid|skipped)\s+lines?|(?:bad|malformed|invalid|skipped)\s+lines?\s*:?\s*2)/i);
  });

  it('renders an all-malformed night without mistaking it for a missing file', async () => {
    writeEvents([null]);
    const instance = app();
    const htmlResponse = await instance.request(`/digest/${night}`);
    const jsonResponse = await instance.request(`/api/digest/${night}`);
    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toMatch(/nothing ran/i);
    expect(html.replace(/<[^>]*>/g, ' '))
      .toMatch(/(?:1\s+(?:bad|malformed|invalid|skipped)\s+lines?|(?:bad|malformed|invalid|skipped)\s+lines?\s*:?\s*1)/i);
    expect(await jsonResponse.json()).toEqual({ night, rows: [], badLines: 1, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('escapes hostile job, owner, and error strings in HTML while keeping their JSON values', async () => {
    const hostile = { ...event, job: '<script>job</script>&', owner: '<img src=x onerror=owner>&',
      status: 'fail', error: '<svg onload=error>&' };
    writeEvents([hostile]);
    const instance = app();
    const htmlResponse = await instance.request(`/digest/${night}`);
    const jsonResponse = await instance.request(`/api/digest/${night}`);
    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    const html = await htmlResponse.text();
    for (const value of [hostile.job, hostile.owner, hostile.error]) {
      expect(html).not.toContain(value);
      expect(html).toContain(value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    }
    expect(html).not.toMatch(/<(?:script|img|svg)\b/i);
    expect(await jsonResponse.json()).toEqual({
      night, badLines: 0, counts: { ok: 0, retry: 0, fail: 1 },
      rows: [{ job: hostile.job, owner: hostile.owner, runs: 1, retries: 0, lastStatus: 'fail', lastError: hostile.error,
        firstAt, lastAt: firstAt, hasFailure: true }],
    });
  });
});
