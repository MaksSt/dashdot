import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HISTORY_INTERVAL_MS,
  HISTORY_RETENTION_MS,
  type HistoryPoint,
} from '@dashdot/common';
import { expect } from 'chai';
import { CONFIG } from '../src/config';
import type { getDynamicServerInfo } from '../src/dynamic-info';
import { HistoryStore, isHistoryPoint, reduceHistory } from '../src/history';
import { makeHistoryPoint, startHistory } from '../src/record-history';

const NOW = Date.UTC(2026, 9, 16, 12);
const point = (time: number, value = 10): HistoryPoint => ({
  time,
  cpuLoad: value,
  cpuTemp: 50,
  nvmeTemp: 40,
  ramUsed: 8 * 1024 ** 3,
  ramTotal: 32 * 1024 ** 3,
  networkUp: 1000,
  networkDown: value * 1000,
});

describe('Persistent metric history', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'dashdot-history-test-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists and restores readings while recovering from a truncated record', async () => {
    const first = point(NOW - 20_000);
    await writeFile(
      path.join(directory, '2026-10-16.jsonl'),
      `${JSON.stringify(first)}\n{"time":`,
    );
    const store = new HistoryStore(directory, () => NOW);
    await store.open();
    store.append(point(NOW - 10_000, 15));
    await store.flush();
    const restored = new HistoryStore(directory, () => NOW);
    await restored.open();
    expect(
      restored.query({ from: NOW - 60_000, to: NOW }).points,
    ).to.deep.equal([first, point(NOW - 10_000, 15)]);
  });

  it('retains only 24 hours and leaves unrelated files untouched', async () => {
    await writeFile(
      path.join(directory, '2026-10-14.jsonl'),
      JSON.stringify(point(NOW - 2 * HISTORY_RETENTION_MS)),
    );
    await writeFile(path.join(directory, 'keep.txt'), 'user file');
    await writeFile(
      path.join(directory, '2026-10-15.jsonl'),
      [
        point(NOW - HISTORY_RETENTION_MS - 10),
        point(NOW - HISTORY_RETENTION_MS + 10),
      ]
        .map((sample) => JSON.stringify(sample))
        .join('\n'),
    );
    const store = new HistoryStore(directory, () => NOW);
    await store.open();
    const response = store.query({
      from: NOW - 10 * HISTORY_RETENTION_MS,
      to: NOW + 1000,
    });
    expect(response.from).to.equal(NOW - HISTORY_RETENTION_MS);
    expect(response.to).to.equal(NOW);
    expect(response.points).to.have.length(1);
    expect(await readFile(path.join(directory, 'keep.txt'), 'utf8')).to.equal(
      'user file',
    );
    let removed = false;
    try {
      await readFile(path.join(directory, '2026-10-14.jsonl'));
    } catch (_error) {
      removed = true;
    }
    expect(removed).to.equal(true);
  });

  it('rejects malformed points and invalid ranges, and deduplicates timestamps', async () => {
    const store = new HistoryStore(directory, () => NOW);
    await store.open();
    store.append(point(NOW - 10_000));
    store.append(point(NOW - 10_000, 90));
    store.append(point(NOW + 1000));
    store.append({ ...point(NOW), cpuLoad: Number.NaN });
    expect(isHistoryPoint({ ...point(NOW), ramUsed: -1 })).to.equal(false);
    expect(isHistoryPoint({ time: NOW })).to.equal(false);
    expect(store.query({ from: NOW - 60_000, to: NOW }).points).to.have.length(
      1,
    );
    expect(() => store.query({ from: NOW, to: NOW - 1 })).to.throw();
    expect(() => store.query({ from: Number.NaN, to: NOW })).to.throw();
  });

  it('marks downtime as a gap and never invents older samples', async () => {
    const store = new HistoryStore(directory, () => NOW);
    store.append(point(NOW - 120_000));
    store.append(point(NOW - 10_000));
    const response = store.query({ from: NOW - HISTORY_RETENTION_MS, to: NOW });
    expect(response.earliest).to.equal(NOW - 120_000);
    expect(response.points[1]?.cpuLoad).to.equal(null);
    expect(response.points[1]?.time).to.equal(NOW - 110_000);
  });

  it('keeps short CPU and traffic peaks within a bounded response', () => {
    const samples = Array.from({ length: 8640 }, (_, index) =>
      point(NOW - HISTORY_RETENTION_MS + index * HISTORY_INTERVAL_MS),
    );
    const cpuPeak = samples[513],
      trafficPeak = samples[2019];
    if (!cpuPeak || !trafficPeak) throw new Error('Missing test fixture');
    cpuPeak.cpuLoad = 100;
    trafficPeak.networkUp = 100_000_000;
    const output = reduceHistory(samples, 1000);
    expect(output.length).to.be.at.most(1000);
    expect(output).to.include(cpuPeak);
    expect(output).to.include(trafficPeak);
    expect(output[0]).to.equal(samples[0]);
    expect(output.at(-1)).to.equal(samples.at(-1));
  });

  it('stops retaining expired readings as time advances', () => {
    let clock = NOW;
    const store = new HistoryStore(directory, () => clock);
    store.append(point(NOW - 1000));
    clock += HISTORY_RETENTION_MS + 2000;
    expect(
      store.query({ from: clock - HISTORY_RETENTION_MS, to: clock }).points,
    ).to.have.length(0);
  });

  it('keeps a metric gap even if another sensor is missing throughout', () => {
    const samples = Array.from({ length: 500 }, (_, index) => ({
      ...point(NOW - 500_000 + index * 1000),
      nvmeTemp: null,
    }));
    const gap = samples[7];
    if (!gap) throw new Error('Missing test fixture');
    gap.cpuTemp = null;
    expect(reduceHistory(samples, 100)).to.include(gap);
  });

  it('subscribes without clients and flushes the last sample on stop', async () => {
    const previousDirectory = CONFIG.history_directory;
    CONFIG.history_directory = directory;
    let unsubscribed = 0;
    const stream = <T>(value: T) => ({
      subscribe: (observer: { next: (sample: T) => void }) => {
        observer.next(value);
        return {
          unsubscribe: () => {
            unsubscribed++;
          },
        };
      },
    });
    try {
      const recorder = await startHistory({
        cpu: stream([{ core: 0, load: 12, temp: 45 }]),
        ram: stream(1024),
        network: stream({ up: 0, down: 0 }),
        storageTemperature: stream([40]),
      } as unknown as ReturnType<typeof getDynamicServerInfo>);
      await recorder.stop();
      const restored = new HistoryStore(directory);
      await restored.open();
      const last = restored
        .query({ from: Date.now() - 60_000, to: Date.now() })
        .points.at(-1);
      expect(last?.cpuLoad).to.equal(12);
      expect(last?.ramUsed).to.equal(1024);
      expect(unsubscribed).to.equal(4);
    } finally {
      CONFIG.history_directory = previousDirectory;
    }
  });
});

describe('History metric sampling', () => {
  const previous = {
    cpu: CONFIG.enable_cpu_temps,
    storage: CONFIG.enable_storage_temps,
    mode: CONFIG.cpu_temps_mode,
  };
  afterEach(() => {
    CONFIG.enable_cpu_temps = previous.cpu;
    CONFIG.enable_storage_temps = previous.storage;
    CONFIG.cpu_temps_mode = previous.mode;
  });

  it('averages CPU load, follows temperature mode, and preserves zero traffic', () => {
    CONFIG.enable_cpu_temps = true;
    CONFIG.enable_storage_temps = true;
    CONFIG.cpu_temps_mode = 'max';
    const sources = {
      cpu: {
        time: NOW,
        value: [
          { core: 0, load: 20, temp: 40 },
          { core: 1, load: 60, temp: 50 },
        ],
      },
      network: { time: NOW, value: { up: 0, down: 0 } },
      temperature: { time: NOW, value: [null, 42, 46] },
    };
    const value = makeHistoryPoint(sources, NOW);
    expect(value.cpuLoad).to.equal(40);
    expect(value.cpuTemp).to.equal(50);
    expect(value.nvmeTemp).to.equal(46);
    expect(value.networkUp).to.equal(0);
    CONFIG.cpu_temps_mode = 'avg';
    expect(makeHistoryPoint(sources, NOW).cpuTemp).to.equal(45);
  });

  it('does not turn unavailable, disabled, or stale readings into zeroes', () => {
    CONFIG.enable_cpu_temps = false;
    CONFIG.enable_storage_temps = false;
    const value = makeHistoryPoint(
      {
        cpu: { time: NOW, value: [{ core: 0, load: 2, temp: 0 }] },
        network: { time: NOW - 1_000_000, value: { up: 20, down: 40 } },
      },
      NOW,
    );
    expect(value.cpuTemp).to.equal(null);
    expect(value.nvmeTemp).to.equal(null);
    expect(value.networkUp).to.equal(null);
    expect(value.ramUsed).to.equal(null);
  });
});
