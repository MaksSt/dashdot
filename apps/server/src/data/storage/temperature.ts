import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StorageInfo, StorageTemperature } from '@dashdot/common';
import { getStaticServerInfo } from '../../static-info';

const NVME_CLASS_PATH = '/sys/class/nvme';
const NVME_DEVICE_PATTERN = /^(nvme\d+)n\d+$/;
const MILLIDEGREES_PER_DEGREE = 1000;

type TemperatureReader = (controller: string) => Promise<number | null>;

export const getNvmeControllerName = (device: string): string | undefined => {
  return NVME_DEVICE_PATTERN.exec(path.basename(device))?.[1];
};

const readNvmeTemperature: TemperatureReader = async (controller) => {
  try {
    const hwmonPath = path.join(NVME_CLASS_PATH, controller, 'device', 'hwmon');
    const hwmonDevices = await readdir(hwmonPath);
    const readings = await Promise.all(
      hwmonDevices.map(async (hwmonDevice) => {
        const rawValue = await readFile(
          path.join(hwmonPath, hwmonDevice, 'temp1_input'),
          'utf8',
        );
        return Number.parseFloat(rawValue) / MILLIDEGREES_PER_DEGREE;
      }),
    );
    const validReadings = readings.filter(Number.isFinite);

    return validReadings.length > 0 ? Math.max(...validReadings) : null;
  } catch (_error) {
    return null;
  }
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
