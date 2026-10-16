import { expect } from 'chai';
import { CONFIG } from '../src/config';
import { DynamicStorageMapper } from '../src/data/storage/dynamic';
import { parseThinPools } from '../src/data/storage/thin-pool';
import { TEST_CASE_24 } from './test-cases';

const table = 'pve-data-tpool: 0 1711710208 thin-pool 252:2 252:3 128 0 0';
const status =
  'pve-data-tpool: 0 1711710208 thin-pool 181 30774/2183168 4907576/13372736 - rw discard_passdown queue_if_no_space - 1024';

describe('LVM thin pool storage', () => {
  beforeEach(() => {
    CONFIG.running_in_docker = true;
    CONFIG.fs_device_filter = [];
  });

  it('converts actual kernel data block counters to bytes', () => {
    expect(parseThinPools(status, table)).to.deep.equal([
      { name: 'pve-data-tpool', device: '252:3', used: 4907576 * 128 * 512 },
    ]);
  });

  it('ignores failed, missing and inconsistent pools', () => {
    expect(
      parseThinPools('pve-data-tpool: 0 100 thin-pool Fail', table),
    ).to.deep.equal([]);
    expect(parseThinPools(status, '')).to.deep.equal([]);
    expect(
      parseThinPools(status.replace('4907576/13372736', '200/100'), table),
    ).to.deep.equal([]);
  });

  it('handles empty pools and different allocation block sizes', () => {
    expect(
      parseThinPools(status.replace('4907576/13372736', '0/13372736'), table)[0]
        ?.used,
    ).to.equal(0);
    expect(
      parseThinPools(status, table.replace('128 0 0', '1024 0 0'))[0]?.used,
    ).to.equal(4907576 * 1024 * 512);
  });

  const map = (disks: string[], mountedFilesystems: string[] = []) =>
    new DynamicStorageMapper(
      false,
      TEST_CASE_24.layout,
      TEST_CASE_24.blocks,
      TEST_CASE_24.sizes,
      [{ disks, used: 1024, mountedFilesystems }],
    ).getMappedLayout();

  it('adds allocated thin pool blocks to the owning physical disk only', () => {
    const device = 'nvme0n1';
    expect(map([device])).to.deep.equal(
      TEST_CASE_24.output.map((used, index) =>
        index === 0 ? used + 1024 : used,
      ),
    );
    expect(map(['unrelated'])).to.deep.equal(TEST_CASE_24.output);
  });

  it('does not count mounted thin filesystems a second time', () => {
    const device = 'nvme0n1';
    const filesystems = TEST_CASE_24.sizes.map(({ fs }) => fs);
    expect(map([device], filesystems)[0]).to.equal(1024);
  });

  it('reports a thin pool without mounted filesystems', () => {
    const output = new DynamicStorageMapper(
      false,
      TEST_CASE_24.layout,
      TEST_CASE_24.blocks,
      [],
      [
        {
          disks: ['nvme0n1'],
          used: 1024,
          mountedFilesystems: [],
        },
      ],
    ).getMappedLayout();
    expect(output[0]).to.equal(1024);
  });
});
