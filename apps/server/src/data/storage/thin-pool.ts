import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type * as si from 'systeminformation';

const execFileAsync = promisify(execFile);
const SECTOR_BYTES = 512;

export type ThinPoolUsage = {
  disks: string[];
  used: number;
  mountedFilesystems: string[];
};

export const parseThinPools = (status: string, table: string) => {
  const tables = new Map(
    table
      .trim()
      .split('\n')
      .flatMap((line) => {
        const match =
          /^(.+):\s+0\s+\d+\s+thin-pool\s+\d+:\d+\s+(\d+:\d+)\s+(\d+)\b/.exec(
            line,
          );
        return match
          ? [
              [
                match[1],
                { device: match[2], blockSize: Number(match[3]) },
              ] as const,
            ]
          : [];
      }),
  );

  return status
    .trim()
    .split('\n')
    .flatMap((line) => {
      const match =
        /^(.+):\s+0\s+\d+\s+thin-pool\s+\d+\s+\d+\/\d+\s+(\d+)\/(\d+)\b/.exec(
          line,
        );
      if (!match) return [];
      const pool = tables.get(match[1]);
      if (!pool || pool.blockSize <= 0 || Number(match[2]) > Number(match[3]))
        return [];
      const used = Number(match[2]) * pool.blockSize * SECTOR_BYTES;
      return Number.isSafeInteger(used)
        ? [{ name: match[1], device: pool.device, used }]
        : [];
    });
};

// Follow device-mapper layers to the actual disk; retain intermediate names
// so mounted thin volumes can be excluded from filesystem usage totals.
const getDependencies = async (
  devicePath: string,
  seen = new Set<string>(),
): Promise<Set<string>> => {
  const resolved = await realpath(devicePath);
  const name = path.basename(resolved);
  if (seen.has(name)) return seen;
  seen.add(name);
  const blockPath = await realpath(`/sys/class/block/${name}`);
  // Physical disks and partitions can omit the slaves directory entirely.
  const slaves = await readdir(path.join(blockPath, 'slaves')).catch(() => []);
  for (const slave of slaves) {
    await getDependencies(path.join(blockPath, 'slaves', slave), seen);
  }
  try {
    await stat(path.join(blockPath, 'partition'));
    seen.add(path.basename(path.dirname(blockPath)));
  } catch (_error) {
    // Whole disks and device-mapper devices do not have a partition attribute.
  }
  return seen;
};

export default async (
  sizes: si.Systeminformation.FsSizeData[],
  blocks: si.Systeminformation.BlockDevicesData[],
): Promise<ThinPoolUsage[]> => {
  if (
    process.platform !== 'linux' ||
    !blocks.some((block) => block.fsType === 'LVM2_member')
  )
    return [];
  try {
    const [status, table] = await Promise.all([
      execFileAsync('dmsetup', ['status', '--target', 'thin-pool'], {
        timeout: 3000,
      }),
      execFileAsync('dmsetup', ['table', '--target', 'thin-pool'], {
        timeout: 3000,
      }),
    ]);
    const filesystems = await Promise.all(
      sizes.map(async ({ fs }) => {
        try {
          return { fs, dependencies: await getDependencies(fs) };
        } catch (_error) {
          return { fs, dependencies: new Set<string>() };
        }
      }),
    );
    const results = await Promise.allSettled(
      parseThinPools(status.stdout, table.stdout).map(async (pool) => {
        const dependencies = await getDependencies(
          `/sys/dev/block/${pool.device}`,
        );
        const disks = blocks
          .filter(
            (block) => block.type === 'disk' && dependencies.has(block.name),
          )
          .map((block) => block.name);
        // A pool spanning disks cannot be attributed from aggregate counters.
        if (disks.length !== 1) return null;
        const poolDevice = path.basename(
          await realpath(`/dev/mapper/${pool.name}`),
        );
        return {
          disks,
          used: pool.used,
          mountedFilesystems: filesystems
            .filter(({ dependencies }) => dependencies.has(poolDevice))
            .map(({ fs }) => fs),
        };
      }),
    );
    return results.flatMap((result) =>
      result.status === 'fulfilled' && result.value ? [result.value] : [],
    );
  } catch (_error) {
    // Keep ordinary filesystem monitoring working without device-mapper access.
    return [];
  }
};
