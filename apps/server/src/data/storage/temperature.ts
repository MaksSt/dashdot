import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { StorageInfo, StorageTemperature } from '@dashdot/common';
import { getStaticServerInfo } from '../../static-info';

const NVME_CLASS_PATH = '/sys/class/nvme';
const HWMON_CLASS_PATH = '/sys/class/hwmon';
const NVME_DEVICE_PATTERN = /^(nvme\d+)n\d+$/;
const NVME_CONTROLLER_PATH_PATTERN = /(?:^|[/\\])(nvme\d+)(?:[/\\]|$)/;
const MILLIDEGREES_PER_DEGREE = 1000;

type TemperatureReader = (controller: string) => Promise<number | null>;

export const getNvmeControllerName = (device: string): string | undefined => {
  return NVME_DEVICE_PATTERN.exec(path.basename(device))?.[1];
};

export const getNvmeControllerFromPath = (
  devicePath: string,
): string | undefined => {
  return NVME_CONTROLLER_PATH_PATTERN.exec(devicePath)?.[1];
};

const readTemperatureFile = async (filePath: string): Promise<number> => {
  const rawValue = await readFile(filePath, 'utf8');
  return Number.parseFloat(rawValue) / MILLIDEGREES_PER_DEGREE;
};

const getMaxTemperature = (readings: number[]): number | null => {
  const validReadings = readings.filter(Number.isFinite);
  return validReadings.length > 0 ? Math.max(...validReadings) : null;
};

const readControllerHwmon = async (
  controller: string,
): Promise<number | null> => {
  try {
    const hwmonPath = path.join(NVME_CLASS_PATH, controller, 'device', 'hwmon');
    const hwmonDevices = await readdir(hwmonPath);
    const results = await Promise.allSettled(
      hwmonDevices.map((hwmonDevice) =>
        readTemperatureFile(path.join(hwmonPath, hwmonDevice, 'temp1_input')),
      ),
    );
    const readings = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );

    return getMaxTemperature(readings);
  } catch (_error) {
    return null;
  }
};

const readGlobalHwmon = async (controller: string): Promise<number | null> => {
  try {
    const hwmonDevices = await readdir(HWMON_CLASS_PATH);
    const sensors = (
      await Promise.all(
        hwmonDevices.map(async (hwmonDevice) => {
          const hwmonPath = path.join(HWMON_CLASS_PATH, hwmonDevice);

          try {
            const name = (await readFile(path.join(hwmonPath, 'name'), 'utf8'))
              .trim()
              .toLowerCase();
            if (name !== 'nvme') return null;

            const [temperature, resolvedPath] = await Promise.all([
              readTemperatureFile(path.join(hwmonPath, 'temp1_input')),
              realpath(hwmonPath),
            ]);

            return {
              controller: getNvmeControllerFromPath(resolvedPath),
              temperature,
            };
          } catch (_error) {
            return null;
          }
        }),
      )
    ).filter((sensor) => sensor != null);

    const matchingReadings = sensors
      .filter((sensor) => sensor.controller === controller)
      .map(({ temperature }) => temperature);
    const matchingTemperature = getMaxTemperature(matchingReadings);
    if (matchingTemperature != null) return matchingTemperature;

    return sensors.length === 1 ? sensors[0].temperature : null;
  } catch (_error) {
    return null;
  }
};

const readNvmeTemperature: TemperatureReader = async (controller) => {
  const controllerTemperature = await readControllerHwmon(controller);
  if (controllerTemperature != null) return controllerTemperature;

  return readGlobalHwmon(controller);
};

export const mapNvmeTemperatures = async (
  layout: StorageInfo,
  readTemperature: TemperatureReader,
): Promise<StorageTemperature> => {
  const temperatureCache = new Map<string, Promise<number | null>>();

  return Promise.all(
    layout.map(async ({ disks }) => {
      const controllers = [
        ...new Set(
          disks
            .filter(({ type }) => type.toUpperCase() === 'NVME')
            .map(({ device }) => getNvmeControllerName(device))
            .filter((controller) => controller != null),
        ),
      ];

      const temperatures = (
        await Promise.all(
          controllers.map((controller) => {
            const cachedTemperature = temperatureCache.get(controller);
            if (cachedTemperature) return cachedTemperature;

            const temperature = readTemperature(controller);
            temperatureCache.set(controller, temperature);
            return temperature;
          }),
        )
      ).filter((temperature) => temperature != null);

      return temperatures.length > 0 ? Math.max(...temperatures) : null;
    }),
  );
};

export default async (): Promise<StorageTemperature> => {
  return mapNvmeTemperatures(
    getStaticServerInfo().storage,
    readNvmeTemperature,
  );
};
