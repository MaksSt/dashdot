import {
  type CpuLoad,
  HISTORY_INTERVAL_MS,
  type HistoryPoint,
  type NetworkLoad,
  type StorageTemperature,
} from '@dashdot/common';
import { CONFIG } from './config';
import type { getDynamicServerInfo } from './dynamic-info';
import { HistoryStore } from './history';
import { getStaticServerInfo } from './static-info';

type Latest<T> = { time: number; value: T };
type Sources = {
  cpu?: Latest<CpuLoad>;
  ram?: Latest<number>;
  network?: Latest<NetworkLoad>;
  temperature?: Latest<StorageTemperature>;
};

const fresh = <T>(
  source: Latest<T> | undefined,
  interval: number,
  now: number,
) =>
  source && now - source.time <= Math.max(30_000, interval * 3)
    ? source.value
    : undefined;
const valid = (value: number | undefined | null) =>
  value != null && Number.isFinite(value) && value >= 0 ? value : null;

export const makeHistoryPoint = (
  sources: Sources,
  now = Date.now(),
): HistoryPoint => {
  const cpu = fresh(sources.cpu, CONFIG.cpu_poll_interval, now);
  const loads =
    cpu?.map(({ load }) => load).filter((value) => valid(value) !== null) ?? [];
  const temps = CONFIG.enable_cpu_temps
    ? (cpu
        ?.map(({ temp }) => temp)
        .filter((value) => Number.isFinite(value) && value > 0) ?? [])
    : [];
  const temperature = fresh(
    sources.temperature,
    CONFIG.storage_poll_interval,
    now,
  );
  const nvme = CONFIG.enable_storage_temps
    ? (temperature?.filter(
        (value): value is number =>
          value != null && Number.isFinite(value) && value > 0,
      ) ?? [])
    : [];
  const ram = fresh(sources.ram, CONFIG.ram_poll_interval, now);
  const network = fresh(sources.network, CONFIG.network_poll_interval, now);
  return {
    time: now,
    cpuLoad: loads.length
      ? Math.min(100, loads.reduce((a, b) => a + b, 0) / loads.length)
      : null,
    cpuTemp: temps.length
      ? CONFIG.cpu_temps_mode === 'max'
        ? Math.max(...temps)
        : temps.reduce((a, b) => a + b, 0) / temps.length
      : null,
    nvmeTemp: nvme.length ? Math.max(...nvme) : null,
    ramUsed: valid(ram),
    ramTotal: valid(CONFIG.override.ram_size ?? getStaticServerInfo().ram.size),
    networkUp: valid(network?.up),
    networkDown: valid(network?.down),
  };
};

export const startHistory = async (
  obs: ReturnType<typeof getDynamicServerInfo>,
) => {
  const store = new HistoryStore(CONFIG.history_directory);
  await store.open();
  const sources: Sources = {};
  const onError = (error: unknown) =>
    console.warn('History metric source stopped.', error);
  const subscriptions = [
    obs.cpu.subscribe({
      next: (value) => {
        sources.cpu = { time: Date.now(), value };
      },
      error: onError,
    }),
    obs.ram.subscribe({
      next: (value) => {
        sources.ram = { time: Date.now(), value };
      },
      error: onError,
    }),
    obs.network.subscribe({
      next: (value) => {
        sources.network = { time: Date.now(), value };
      },
      error: onError,
    }),
    obs.storageTemperature.subscribe({
      next: (value) => {
        sources.temperature = { time: Date.now(), value };
      },
      error: onError,
    }),
  ];
  const sample = () => {
    const point = makeHistoryPoint(sources);
    if (
      [point.cpuLoad, point.ramUsed, point.nvmeTemp, point.networkUp].some(
        (value) => value !== null,
      )
    )
      store.append(point);
  };
  const timer = setInterval(sample, HISTORY_INTERVAL_MS);
  const flushTimer = setInterval(() => {
    void store.flush();
  }, 60_000);
  timer.unref();
  flushTimer.unref();
  return {
    store,
    stop: async () => {
      clearInterval(timer);
      clearInterval(flushTimer);
      sample();
      subscriptions.forEach((subscription) => {
        subscription.unsubscribe();
      });
      await store.flush();
    },
  };
};
