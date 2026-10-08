// Re-encodes one network's mining address for the other network, so a shared key's 9… / 3… address
// shows even when that network's node isn't running (a node only encodes its own network's
// addresses). This is the only use of @noble/hashes; each network's own key comes from its node.
import { blake2b } from '@noble/hashes/blake2.js'
import type { Network } from '@shared/types'

/** Ergo address checksum is the first 4 bytes of blake2b256. */
const CHECKSUM_LENGTH = 4
/** P2PK type nibble. The public key bytes after the header stay the same on every network. */
const P2PK = 1
const NETWORK_PREFIX: Record<Network, number> = { mainnet: 0, testnet: 16 }

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const INDEX = new Map([...ALPHABET].map((char, index) => [char, index]))

function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 })
}

function decodeBase58(text: string): Uint8Array | null {
  if (!text) return null
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++
  const bytes: number[] = [0]
  for (let i = zeros; i < text.length; i++) {
    const value = INDEX.get(text[i])
    if (value === undefined) return null
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]
  return out
}

function encodeBase58(data: Uint8Array): string {
  let zeros = 0
  while (zeros < data.length && data[zeros] === 0) zeros++
  const digits: number[] = [0]
  for (let i = zeros; i < data.length; i++) {
    let carry = data[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let text = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) text += ALPHABET[digits[i]]
  return text
}

function checksum(payload: Uint8Array): Uint8Array {
  return blake2b256(payload).subarray(0, CHECKSUM_LENGTH)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Decodes a valid P2PK address. Returns the header byte plus the public key,
 * without the checksum. Null when the text is not a P2PK address.
 */
function p2pkPayload(address: string): Uint8Array | null {
  const bytes = decodeBase58(address)
  if (!bytes || bytes.length <= CHECKSUM_LENGTH + 1) return null
  const payload = bytes.subarray(0, bytes.length - CHECKSUM_LENGTH)
  if ((payload[0] & 0x0f) !== P2PK) return null
  const prefix = payload[0] & 0xf0
  if (prefix !== NETWORK_PREFIX.mainnet && prefix !== NETWORK_PREFIX.testnet) return null
  if (!sameBytes(bytes.subarray(payload.length), checksum(payload))) return null
  return payload
}

/** Public key bytes of a P2PK address, or null when `address` is not one. */
export function p2pkContent(address: string): Uint8Array | null {
  const payload = p2pkPayload(address)
  return payload ? payload.subarray(1) : null
}

/** True for an Ergo P2PK address (mainnet 9… or testnet 3…). Seeds and passwords are not addresses. */
export function isP2pkAddress(address: string): boolean {
  return p2pkPayload(address) !== null
}

/**
 * Rewrites a P2PK address for `network`. The public key is unchanged, so one seed
 * spends both; only the network byte and checksum differ. Mainnet addresses start
 * with 9 and testnet addresses start with 3. Anything that is not a P2PK address
 * is returned unchanged.
 */
export function addressForNetwork(address: string, network: Network): string {
  const payload = p2pkPayload(address)
  if (!payload) return address
  const next = new Uint8Array(payload.length + CHECKSUM_LENGTH)
  next.set(payload)
  next[0] = NETWORK_PREFIX[network] | P2PK
  next.set(checksum(next.subarray(0, payload.length)), payload.length)
  return encodeBase58(next)
}
