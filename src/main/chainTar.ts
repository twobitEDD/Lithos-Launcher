// Plain ustar, regular files only. Enough for a chain copy and readable by any `tar`.

const BLOCK = 512
const OCTAL_SIZE_MAX = 0o77777777777

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new Error(`Tar field too long: ${value}`)
  bytes.copy(buf, offset)
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  writeString(buf, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

/** Sizes over 8 GiB use the GNU base-256 form, which GNU and BSD tar both read. */
function writeSize(buf: Buffer, offset: number, size: number): void {
  if (size <= OCTAL_SIZE_MAX) {
    writeOctal(buf, offset, 12, size)
    return
  }
  buf[offset] = 0x80
  let rest = BigInt(size)
  for (let i = 11; i >= 1; i--) {
    buf[offset + i] = Number(rest & 0xffn)
    rest >>= 8n
  }
}

function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`Path too long for tar: ${path}`)
}

/** The 512-byte header for one regular file. */
export function tarHeader(path: string, size: number, mtimeSeconds = 0): Buffer {
  const buf = Buffer.alloc(BLOCK)
  const { name, prefix } = splitName(path)
  writeString(buf, 0, 100, name)
  writeOctal(buf, 100, 8, 0o644)
  writeOctal(buf, 108, 8, 0)
  writeOctal(buf, 116, 8, 0)
  writeSize(buf, 124, size)
  writeOctal(buf, 136, 12, Math.max(0, Math.floor(mtimeSeconds)))
  buf.fill(0x20, 148, 156)
  buf[156] = 0x30 // '0' regular file
  writeString(buf, 257, 6, 'ustar\0')
  writeString(buf, 263, 2, '00')
  writeString(buf, 345, 155, prefix)
  let sum = 0
  for (const byte of buf) sum += byte
  writeString(buf, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return buf
}

/** Zero bytes after `size` bytes of data, up to the next block. */
export function tarPadding(size: number): Buffer {
  const rest = size % BLOCK
  return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest)
}

/** Two zero blocks end an archive. */
export function tarEnd(): Buffer {
  return Buffer.alloc(BLOCK * 2)
}

function readString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset)
  return buf.toString('utf8', offset, end === -1 || end > offset + length ? offset + length : end)
}

function readSize(buf: Buffer, offset: number): number {
  if (buf[offset] & 0x80) {
    let value = 0n
    for (let i = 1; i < 12; i++) value = (value << 8n) | BigInt(buf[offset + i])
    return Number(value)
  }
  const text = readString(buf, offset, 12).trim()
  if (!/^[0-7]*$/.test(text)) throw new Error('Malformed tar size')
  return text ? parseInt(text, 8) : 0
}

function checksumOk(buf: Buffer): boolean {
  const stored = parseInt(readString(buf, 148, 8).trim(), 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[i]
  return stored === sum
}

export interface TarHandler {
  /** Called once per regular file. Throw to stop. */
  begin(path: string, size: number): Promise<void> | void
  data(chunk: Buffer): Promise<void> | void
  end(): Promise<void> | void
}

/**
 * Reads a ustar stream from `source` and hands each file to `handler`, awaiting every call so a
 * slow disk slows the download instead of filling memory. Anything but regular files is refused.
 * Resolves only after the end-of-archive marker; a stream that stops early rejects.
 */
export async function extractTar(source: AsyncIterable<Uint8Array>, handler: TarHandler): Promise<void> {
  let pending = Buffer.alloc(0)
  let remaining = 0
  let padding = 0
  let inFile = false
  let zeroBlocks = 0
  let finished = false

  const step = async (): Promise<boolean> => {
    if (inFile) {
      if (remaining > 0) {
        if (pending.length === 0) return false
        const take = Math.min(remaining, pending.length)
        const chunk = pending.subarray(0, take)
        pending = pending.subarray(take)
        remaining -= take
        await handler.data(chunk)
        return true
      }
      if (pending.length < padding) return false
      pending = pending.subarray(padding)
      inFile = false
      await handler.end()
      return true
    }
    if (pending.length < BLOCK) return false
    const header = pending.subarray(0, BLOCK)
    pending = pending.subarray(BLOCK)
    if (header.every((byte) => byte === 0)) {
      zeroBlocks++
      if (zeroBlocks >= 2) finished = true
      return true
    }
    zeroBlocks = 0
    if (!checksumOk(header)) throw new Error('The copy is damaged (bad tar header)')
    const type = header[156]
    if (type !== 0x30 && type !== 0) throw new Error('The copy contains something other than plain files')
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const size = readSize(header, 124)
    remaining = size
    padding = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK)
    inFile = true
    await handler.begin(path, size)
    return true
  }

  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, Buffer.from(chunk)]) : Buffer.from(chunk)
    while (!finished && (await step())) {
      // keep consuming what is buffered
    }
    if (finished) break
  }
  while (!finished && (await step())) {
    // drain
  }
  if (!finished) throw new Error('The copy ended before the archive was complete')
}
