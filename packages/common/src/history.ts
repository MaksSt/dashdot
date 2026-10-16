export const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const HISTORY_INTERVAL_MS = 10_000;
export const HISTORY_METRICS = [
  'cpuLoad',
  'cpuTemp',
  'nvmeTemp',
  'ramUsed',
  'ramTotal',
  'networkUp',
  'networkDown',
] as const;
export type HistoryMetric = (typeof HISTORY_METRICS)[number];
export type HistoryPoint = { time: number } & Record<
  HistoryMetric,
  number | null
>;
export type HistoryRequest = { from: number; to: number; points?: number };
export type HistoryResponse = {
  from: number;
  to: number;
  earliest: number | null;
  latest: number | null;
  interval: number;
  retention: number;
  points: HistoryPoint[];
  warning?: string;
};
export type HistoryResult = HistoryResponse | { error: string };

export const historyRange = (from: number, to: number, now = Date.now()) => {
  const end = Math.min(now, to);
  const start = Math.max(now - HISTORY_RETENTION_MS, from);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('Choose a valid time range within the last 24 hours.');
  }
  return { from: start, to: end };
};
