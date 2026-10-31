export type RunStatus = 'ok' | 'retry' | 'fail';

export type DigestRow = {
  job: string;
  owner: string | null;
  runs: number;
  retries: number;
  lastStatus: RunStatus;
  lastError: string | null;
  firstAt: string;
  lastAt: string;
  hasFailure: boolean;
};

export type DigestResult = {
  night: string;
  rows: DigestRow[];
  badLines: number;
  counts: Record<RunStatus, number>;
};

// Invalid calendar nights and missing files return null; other filesystem errors throw.
export type ReadNight = (runsDir: string, night: string) => DigestResult | null;
