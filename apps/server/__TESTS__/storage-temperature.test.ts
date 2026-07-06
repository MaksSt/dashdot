import type { StorageInfo } from '@dashdot/common';
import { expect } from 'chai';
import {
  getNvmeControllerName,
  mapNvmeTemperatures,
} from '../src/data/storage/temperature';

const layout: StorageInfo = [
  {
    size: 1,
    disks: [
      {
        device: 'nvme0n1',
        brand: 'First',
        type: 'NVMe',
      },
    ],
  },
  {
    size: 2,
    disks: [
      {
        device: '/dev/nvme1n1',
        brand: 'Second',
        type: 'NVMe',
      },
      {
        device: 'nvme2n1',
        brand: 'Third',
        type: 'NVMe',
      },
    ],
  },
  {
    size: 3,
    disks: [
      {
        device: 'sda',
        brand: 'Fourth',
        type: 'SSD',
      },
    ],
  },
];

describe('Storage temperature', () => {
  it('extracts the NVMe controller from a namespace device', () => {
    expect(getNvmeControllerName('nvme0n1')).to.equal('nvme0');
    expect(getNvmeControllerName('/dev/nvme12n3')).to.equal('nvme12');
    expect(getNvmeControllerName('sda')).to.equal(undefined);
  });

  it('maps temperatures to storage entries and uses the hottest RAID disk', async () => {
    const temperatures = new Map([
      ['nvme0', 46.9],
      ['nvme1', 42.5],
      ['nvme2', 48.1],
    ]);

    const output = await mapNvmeTemperatures(
      layout,
      async (controller) => temperatures.get(controller) ?? null,
    );

    expect(output).to.deep.equal([46.9, 48.1, null]);
  });
});
