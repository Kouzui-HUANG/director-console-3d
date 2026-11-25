/** Reference photo plumbing without a browser: EXIF focal length and the reference commands. */
import { describe, expect, it } from 'vitest';
import { runPortraitCommands } from '../../src/portrait/core/commands.ts';
import { newPortrait } from '../../src/portrait/core/schema.ts';
import { readExif, trustedFocal35 } from '../../src/portrait/photo/exif.ts';

/** A minimal JPEG with an EXIF block (little endian): make, model, focal length 4.25 mm, 26 mm equivalent, 4032 × 3024. */
function jpegWithExif(): ArrayBuffer {
  const t: number[] = [];
  const u16 = (v: number) => t.push(v & 255, v >> 8);
  const u32 = (v: number) => t.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
  // TIFF header
  t.push(0x49, 0x49);
  u16(42);
  u32(8);
  // IFD0 at 8: Make, Model, ExifIFD pointer
  u16(3);
  const ifd0Data = 8 + 2 + 3 * 12 + 4; // 50
  u16(0x010f), u16(2), u32(6), u32(ifd0Data); // "Apple\0"
  u16(0x0110), u16(2), u32(4), t.push(0x58, 0x52, 0x00, 0x00); // "XR\0" inline
  u16(0x8769), u16(4), u32(1), u32(ifd0Data + 6);
  u32(0);
  t.push(...[...'Apple'].map((c) => c.charCodeAt(0)), 0);
  // Exif IFD at 56: focal 35, focal (rational), pixel x / y
  const exif = ifd0Data + 6;
  u16(4);
  const rational = exif + 2 + 4 * 12 + 4;
  u16(0xa405), u16(3), u32(1), u16(26), u16(0);
  u16(0x920a), u16(5), u32(1), u32(rational);
  u16(0xa002), u16(4), u32(1), u32(4032);
  u16(0xa003), u16(4), u32(1), u32(3024);
  u32(0);
  u32(425), u32(100);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t];
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xd9]).buffer;
}

describe('EXIF', () => {
  it('reads the focal length and the recorded size', () => {
    const e = readExif(jpegWithExif())!;
    expect(e).toEqual({ focal35: 26, focalMm: 4.25, pixelX: 4032, pixelY: 3024, make: 'Apple', model: 'XR' });
  });
  it('trusts the focal length only for the recorded frame shape (any orientation)', () => {
    const e = readExif(jpegWithExif());
    expect(trustedFocal35(e, 4032, 3024)).toBe(26);
    expect(trustedFocal35(e, 1512, 2016)).toBe(26); // rotated and scaled down
    expect(trustedFocal35(e, 1000, 1000)).toBeNull(); // cropped
    expect(trustedFocal35(null, 100, 100)).toBeNull();
  });
  it('returns null for files without EXIF or not JPEG', () => {
    expect(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull();
    expect(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBeNull();
    expect(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 40, 1]).buffer)).toBeNull(); // truncated
  });
});

describe('reference commands', () => {
  const p0 = newPortrait({ name: '照片' });
  const run = (p: typeof p0, calls: Parameters<typeof runPortraitCommands>[1]) => {
    const r = runPortraitCommands(p, calls);
    if (!r.ok) throw new Error(r.error.message);
    return r.portrait;
  };
  it('adds, updates and removes references (undoable patches)', () => {
    const p1 = run(p0, [{ cmd: 'portrait.addReference', args: { id: 'refabc', file: 'refs/x/refabc.jpg', note: '正面', focal35: 26 } }]);
    expect(p1.references).toEqual([{ id: 'refabc', file: 'refs/x/refabc.jpg', note: '正面', focal35: 26 }]);
    const dup = runPortraitCommands(p1, [{ cmd: 'portrait.addReference', args: { id: 'refabc', file: 'refs/x/other.jpg' } }]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('DUPLICATE_ID');
    expect(run(p1, [{ cmd: 'portrait.updateReference', args: { id: 'refabc', note: '3/4', focal35: null } }]).references[0]).toEqual({ id: 'refabc', file: 'refs/x/refabc.jpg', note: '3/4', focal35: null });
    expect(run(p1, [{ cmd: 'portrait.updateReference', args: { id: 'refabc', focal35: 50 } }]).references[0]!.note).toBe('正面');
    expect(run(p1, [{ cmd: 'portrait.removeReference', args: { id: 'refabc' } }]).references).toEqual([]);
    const missing = runPortraitCommands(p1, [{ cmd: 'portrait.removeReference', args: { id: 'refzzz' } }]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.hint).toContain('refabc');
  });
});
