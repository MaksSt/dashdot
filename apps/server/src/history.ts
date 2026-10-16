import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  HISTORY_INTERVAL_MS,
  HISTORY_METRICS,
  HISTORY_RETENTION_MS,
  type HistoryPoint,
  type HistoryRequest,
  type HistoryResponse,
  historyRange,
} from '@dashdot/common';

const dateKey = (time: number) => new Date(time).toISOString().slice(0, 10);
const historyFile = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export const isHistoryPoint = (value: unknown): value is HistoryPoint => {
  if (!value || typeof value !== 'object') return false;
  const point = value as HistoryPoint;
  return (
    Number.isSafeInteger(point.time) &&
    point.time > 0 &&
    HISTORY_METRICS.every(
      (key) =>
        point[key] === null ||
        (typeof point[key] === 'number' &&
          Number.isFinite(point[key]) &&
          point[key] >= 0),
    )
  );
};

// Keep extrema for every metric rather than averaging away short spikes.
export const reduceHistory = (
  points: HistoryPoint[],
  limit: number,
): HistoryPoint[] => {
  if (points.length <= limit) return points;
  const bucketSize = Math.ceil(
    points.length / Math.max(1, Math.floor(limit / 23)),
  );
  const result = new Set<HistoryPoint>();
  for (let offset = 0; offset < points.length; offset += bucketSize) {
    const bucket = points.slice(offset, offset + bucketSize);
    const first = bucket[0],
      last = bucket.at(-1);
    if (first) result.add(first);
    if (last) result.add(last);
    for (const key of HISTORY_METRICS) {
      let min: HistoryPoint | undefined, max: HistoryPoint | undefined;
      for (const point of bucket) {
        const value = point[key];
        if (value === null) continue;
        if (!min || value < (min[key] ?? Infinity)) min = point;
        if (!max || value > (max[key] ?? -Infinity)) max = point;
      }
      if (min) result.add(min);
      if (max) result.add(max);
      const gap = bucket.find((point) => point[key] === null);
      if (gap) result.add(gap);
    }
  }
  return [...result].sort((a, b) => a.time - b.time);
};

export class HistoryStore {
  private points: HistoryPoint[] = [];
  private pending: HistoryPoint[] = [];
  private writing: Promise<void> | undefined;
  public persistenceError = false;

  constructor(
    private directory: string,
    private now = Date.now,
  ) {}

  async open() {
    try {
      await mkdir(this.directory, { recursive: true });
      const oldest = `${dateKey(this.now() - HISTORY_RETENTION_MS)}.jsonl`;
      for (const name of (await readdir(this.directory)).sort()) {
        if (!historyFile.test(name)) continue;
        if (name < oldest) {
          await unlink(path.join(this.directory, name));
          continue;
        }
        const lines = createInterface({
          input: createReadStream(path.join(this.directory, name)),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          try {
            const point: unknown = JSON.parse(line);
            if (
              isHistoryPoint(point) &&
              point.time >= this.now() - HISTORY_RETENTION_MS &&
              point.time <= this.now()
            )
              this.points.push(point);
          } catch (_error) {
            // A partial final line after a crash must not discard the other days.
          }
        }
      }
      this.points = [
        ...new Map(this.points.map((point) => [point.time, point])).values(),
      ].sort((a, b) => a.time - b.time);
      this.prune();
    } catch (error) {
      this.persistenceError = true;
      console.warn(
        'Unable to load metric history; collecting in memory.',
        error,
      );
    }
  }

  private prune() {
    const oldest = this.now() - HISTORY_RETENTION_MS;
    const first = this.points.findIndex((point) => point.time >= oldest);
    if (first === -1) this.points = [];
    else if (first > 0) this.points.splice(0, first);
    // Bound memory even when the system clock moves or a file is malformed.
    const capacity = Math.ceil(HISTORY_RETENTION_MS / HISTORY_INTERVAL_MS) + 1;
    if (this.points.length > capacity)
      this.points.splice(0, this.points.length - capacity);
    this.pending = this.pending
      .filter((point) => point.time >= oldest)
      .slice(-capacity);
  }

  append(point: HistoryPoint) {
    if (
      !isHistoryPoint(point) ||
      point.time > this.now() ||
      point.time <= (this.points.at(-1)?.time ?? 0)
    )
      return;
    this.points.push(point);
    this.pending.push(point);
    this.prune();
  }

  flush(): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = this.writePending().finally(() => {
      this.writing = undefined;
    });
    return this.writing;
  }

  private async writePending() {
    try {
      await mkdir(this.directory, { recursive: true });
      while (this.pending.length > 0) {
        const day = dateKey(this.pending[0]?.time ?? this.now());
        const batch = this.pending.filter(
          (point) => dateKey(point.time) === day,
        );
        // A leading newline also separates a partial trailing record after a crash.
        await appendFile(
          path.join(this.directory, `${day}.jsonl`),
          `\n${batch.map((point) => JSON.stringify(point)).join('\n')}\n`,
        );
        const written = new Set(batch);
        this.pending = this.pending.filter((point) => !written.has(point));
      }
      const oldest = `${dateKey(this.now() - HISTORY_RETENTION_MS)}.jsonl`;
      for (const name of await readdir(this.directory)) {
        if (historyFile.test(name) && name < oldest)
          await unlink(path.join(this.directory, name));
      }
      this.persistenceError = false;
    } catch (error) {
      this.persistenceError = true;
      console.warn('Unable to persist metric history; will retry.', error);
    }
  }

  query(request: HistoryRequest): HistoryResponse {
    this.prune();
    const { from, to } = historyRange(request.from, request.to, this.now());
    const limit = Math.min(
      2000,
      Math.max(
        100,
        Number.isFinite(request.points)
          ? Math.floor(request.points ?? 1000)
          : 1000,
      ),
    );
    const raw = this.points.filter(
      (point) => point.time >= from && point.time <= to,
    );
    const gaps: HistoryPoint[] = [];
    for (let index = 1; index < raw.length; index++) {
      const previous = raw[index - 1],
        current = raw[index];
      if (
        previous &&
        current &&
        current.time - previous.time > HISTORY_INTERVAL_MS * 3
      ) {
        gaps.push({
          time: previous.time + HISTORY_INTERVAL_MS,
          cpuLoad: null,
          cpuTemp: null,
          nvmeTemp: null,
          ramUsed: null,
          ramTotal: null,
          networkUp: null,
          networkDown: null,
        });
      }
    }
    return {
      from,
      to,
      earliest: this.points[0]?.time ?? null,
      latest: this.points.at(-1)?.time ?? null,
      interval: HISTORY_INTERVAL_MS,
      retention: HISTORY_RETENTION_MS,
      points: reduceHistory(
        raw.concat(gaps).sort((a, b) => a.time - b.time),
        limit,
      ),
      ...(this.persistenceError
        ? {
            warning:
              'History is currently stored in memory only and may be lost on restart.',
          }
        : {}),
    };
  }
}
