/**
 * @fileoverview Read an image's format and dimensions from its header bytes.
 *
 * Providers occasionally mislabel output or return an error page with a 200,
 * so `runImage` trusts the bytes rather than the declared media type. Only
 * the formats image APIs actually return are recognized.
 */

export interface SniffedImage {
  readonly mediaType: string
  readonly width: number
  readonly height: number
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  )
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function sniffPng(bytes: Uint8Array): SniffedImage | undefined {
  // Signature, then the IHDR chunk: length (4) + "IHDR" (4) + width + height.
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return undefined
  return { mediaType: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | undefined {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]!
    // Fill bytes and standalone markers carry no length field.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = u16be(bytes, offset + 2)
    // SOF0..SOF15 hold the frame size; C4 (DHT), C8 (JPG), and CC (DAC) share
    // the range but are not frame headers.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      if (offset + 9 > bytes.length) return undefined
      return {
        mediaType: 'image/jpeg',
        height: u16be(bytes, offset + 5),
        width: u16be(bytes, offset + 7),
      }
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

function sniffWebp(bytes: Uint8Array): SniffedImage | undefined {
  if (bytes.length < 30) return undefined
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8 ') {
    // Lossy: frame tag (3) + start code (3) at 20, then 14-bit width/height.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined
    return {
      mediaType: 'image/webp',
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    // Lossless: signature 0x2f at 20, then 14-bit width-1 and height-1 packed LE.
    if (bytes[20] !== 0x2f) return undefined
    const b0 = bytes[21]!
    const b1 = bytes[22]!
    const b2 = bytes[23]!
    const b3 = bytes[24]!
    return {
      mediaType: 'image/webp',
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    }
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit canvas width-1 and height-1 at 24 and 27.
    return {
      mediaType: 'image/webp',
      width: 1 + u24le(bytes, 24),
      height: 1 + u24le(bytes, 27),
    }
  }
  return undefined
}

/**
 * Detect PNG, JPEG, or WebP and read its dimensions. Returns `undefined` for
 * anything else, including truncated headers and zero-sized images.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
  let sniffed: SniffedImage | undefined
  if (startsWith(bytes, PNG_SIGNATURE)) sniffed = sniffPng(bytes)
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) sniffed = sniffJpeg(bytes)
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') sniffed = sniffWebp(bytes)
  if (sniffed === undefined || sniffed.width <= 0 || sniffed.height <= 0) return undefined
  return sniffed
}
