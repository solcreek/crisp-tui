import { deflateSync } from "node:zlib"

function chunk(type: string, data: Uint8Array) {
  const payload = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of payload) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  const header = Buffer.alloc(4), checksum = Buffer.alloc(4)
  header.writeUInt32BE(data.byteLength); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([header, payload, checksum])
}

/** Synthetic, striped PNG: no customer data or network fixture. */
export function testPng(width = 64, height = 32, headerWidth = width, headerHeight = height, compressionLevel = -1) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(headerWidth, 0); header.writeUInt32BE(headerHeight, 4)
  header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4
    pixels.set(x < width / 3 ? [84, 165, 255, 255] : x < 2 * width / 3 ? [106, 214, 177, 255] : [240, 195, 106, 255], offset)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels, { level: compressionLevel })), chunk("IEND", new Uint8Array())])
}
