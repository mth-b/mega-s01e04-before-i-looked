import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestResult, DigestRow, ReadNight } from './types.js';

function validNight(night: string): boolean {
  if (night.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(night)) return false;
  const date = new Date(`${night}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === night;
}

function timestamp(at: unknown): number | null {
  if (typeof at !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(at);
  if (!match || match[0] !== at || !validNight(match[1])) return null;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  if (match[6] && (Number(match[6]) > 23 || Number(match[7]) > 59)) return null;
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : null;
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!validNight(night)) return null;
  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const result: DigestResult = { night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } };
  const rows = new Map<string, DigestRow>();
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      result.badLines++;
      continue;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      result.badLines++;
      continue;
    }
    const { at, job, status, owner, error } = event as Record<string, unknown>;
    const time = timestamp(at);
    if (time === null || typeof at !== 'string' || typeof job !== 'string' || !job.trim()
      || (status !== 'ok' && status !== 'retry' && status !== 'fail')
      || (owner !== null && typeof owner !== 'string')
      || (error !== undefined && typeof error !== 'string')) {
      result.badLines++;
      continue;
    }

    result.counts[status]++;
    const row = rows.get(job);
    if (!row) {
      rows.set(job, {
        job, owner, runs: 1, retries: status === 'retry' ? 1 : 0,
        lastStatus: status, lastError: error ?? null, firstAt: at, lastAt: at,
        hasFailure: status === 'fail',
      });
      continue;
    }
    row.runs++;
    if (status === 'retry') row.retries++;
    if (status === 'fail') row.hasFailure = true;
    if (time < Date.parse(row.firstAt)) row.firstAt = at;
    // Equal timestamps use the later line, keeping the final event's fields together.
    if (time >= Date.parse(row.lastAt)) {
      row.lastAt = at;
      row.lastStatus = status;
      row.lastError = error ?? null;
      row.owner = owner;
    }
  }
  result.rows = [...rows.values()].sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return result;
};
