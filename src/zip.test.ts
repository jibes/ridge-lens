import { describe, expect, it } from 'vitest';
import { crc32, makeZip } from './zip';

describe('ZIP', () => {
  it('CRC-32 nach Norm', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('Kopf, Verzeichnis und Ende stimmen', () => {
    const data = new TextEncoder().encode('hallo');
    const z = makeZip([{ name: 'a/b.txt', data }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(18, true)).toBe(5);
    const end = z.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(1);
    expect(v.getUint32(v.getUint32(end + 16, true), true)).toBe(0x02014b50);
  });
});
