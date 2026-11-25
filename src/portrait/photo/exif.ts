/**
 * Minimal EXIF reader for JPEG files: the focal length (35 mm equivalent and actual) and the
 * pixel size the camera recorded — enough to give the photo fit a focal-length prior.
 */
export interface ExifInfo {
  focal35: number | null;
  focalMm: number | null;
  pixelX: number | null;
  pixelY: number | null;
  make: string | null;
  model: string | null;
}

export function readExif(buf: ArrayBuffer): ExifInfo | null {
  try {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) return null;
      if (marker === 0xffda || marker === 0xffd9) return null; // image data starts: no EXIF
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) return parseTiff(v, off + 10);
      off += 2 + len;
    }
  } catch {
    /* truncated or malformed */
  }
  return null;
}

function parseTiff(v: DataView, base: number): ExifInfo | null {
  const le = v.getUint16(base) === 0x4949;
  const u16 = (o: number) => v.getUint16(base + o, le);
  const u32 = (o: number) => v.getUint32(base + o, le);
  if (u16(2) !== 42) return null;
  const out: ExifInfo = { focal35: null, focalMm: null, pixelX: null, pixelY: null, make: null, model: null };
  const entries = (ifd: number) => {
    const n = u16(ifd);
    const list: { tag: number; type: number; count: number; at: number }[] = [];
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      list.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return list;
  };
  const num = (e: { type: number; at: number }) => (e.type === 3 ? u16(e.at) : e.type === 4 ? u32(e.at) : e.type === 5 ? u32(u32(e.at)) / (u32(u32(e.at) + 4) || 1) : null);
  const text = (e: { count: number; at: number }) => {
    const at = e.count > 4 ? u32(e.at) : e.at;
    let s = '';
    for (let i = 0; i < e.count && i < 64; i++) {
      const ch = v.getUint8(base + at + i);
      if (!ch) break;
      s += String.fromCharCode(ch);
    }
    return s.trim() || null;
  };
  let exifIfd = 0;
  for (const e of entries(u32(4))) {
    if (e.tag === 0x010f) out.make = text(e);
    else if (e.tag === 0x0110) out.model = text(e);
    else if (e.tag === 0x8769) exifIfd = u32(e.at);
  }
  if (exifIfd) {
    for (const e of entries(exifIfd)) {
      if (e.tag === 0xa405) out.focal35 = num(e) || null;
      else if (e.tag === 0x920a) out.focalMm = num(e) || null;
      else if (e.tag === 0xa002) out.pixelX = num(e);
      else if (e.tag === 0xa003) out.pixelY = num(e);
    }
  }
  return out;
}

/**
 * The 35 mm-equivalent focal length to trust for an image of `width` × `height`: only when the
 * recorded frame has the same shape (a cropped photo has another field of view).
 */
export function trustedFocal35(exif: ExifInfo | null, width: number, height: number): number | null {
  if (!exif?.focal35 || exif.focal35 < 8 || exif.focal35 > 1200) return null;
  if (exif.pixelX && exif.pixelY) {
    const a = exif.pixelX / exif.pixelY, b = width / height;
    if (Math.abs(a / b - 1) > 0.01 && Math.abs(a * b - 1) > 0.01) return null;
  }
  return exif.focal35;
}
