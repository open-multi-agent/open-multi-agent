/**
 * Minimal image headers for tests. `sniffImage` reads only the header, so
 * these are not decodable images, just enough bytes to carry format and size.
 */

export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // IHDR
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 with a 2-byte payload
    0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, length 17, precision 8
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
}

function riff(chunk: string, payload: number[]): Uint8Array {
  // Padded to the 30-byte minimum a real WebP header always reaches.
  const bytes = new Uint8Array(Math.max(30, 20 + payload.length))
  bytes.set([...'RIFF'].map(c => c.charCodeAt(0)), 0)
  bytes.set([...'WEBP'].map(c => c.charCodeAt(0)), 8)
  bytes.set([...chunk].map(c => c.charCodeAt(0)), 12)
  bytes.set(payload, 20)
  return bytes
}

export function webpVp8xHeader(width: number, height: number): Uint8Array {
  const w = width - 1
  const h = height - 1
  return riff('VP8X', [
    0x00, 0x00, 0x00, 0x00,
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ])
}

export function webpVp8Header(width: number, height: number): Uint8Array {
  return riff('VP8 ', [
    0x00, 0x00, 0x00, // frame tag
    0x9d, 0x01, 0x2a, // start code
    width & 0xff, (width >> 8) & 0x3f,
    height & 0xff, (height >> 8) & 0x3f,
  ])
}

export function webpVp8lHeader(width: number, height: number): Uint8Array {
  const w = width - 1
  const h = height - 1
  const bits = w | (h << 14)
  return riff('VP8L', [
    0x2f,
    bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff,
  ])
}
