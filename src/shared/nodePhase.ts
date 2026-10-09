// One plain line for the node card and the diagnostics bundle: what the node is doing right now,
// or why it is not. No Node or DOM imports.

import type { NodeInfo, NodeStartup, ProcStatus } from './types'

const SLACK = 2

/** After this long with peers but no reported chain height, the line says something is wrong. */
export const HEIGHT_STALL_MS = 3 * 60_000

export type NodePhaseTone = 'idle' | 'busy' | 'ok' | 'warn' | 'error'

export interface NodePhase {
  tone: NodePhaseTone
  text: string
}

export interface NodePhaseInput {
  status: ProcStatus
  detail: string | null
  info: NodeInfo | null
  installed: boolean
  /** This computer is using another machine's launcher instead. */
  remote: boolean
  /** A LAN chain copy owns the node; its own line explains. */
  copying: boolean
  /** Peers connected but none reported a height, since this time (ms). Null when not in that state. */
  noHeightSince: number | null
  now: number
}

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m === 1 ? '1 min' : `${m} min`
}

/** True while peers are connected but none has told this node how high the chain is. */
export function waitingForPeerHeight(info: NodeInfo | null): boolean {
  return info !== null && info.peersCount > 0 && !info.maxPeerHeight && !(info.headersHeight && info.headersHeight > 0)
}

/** "40 min", "6 h", "3 days". */
export function durationText(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60))
  if (min < 90) return `${min} min`
  const hours = Math.round(min / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}

function indexerText(startup: NodeStartup | null | undefined): string {
  const ix = startup?.indexer
  return ix ? ` Indexing block ${n(ix.block)} / ${n(ix.target)}.` : ''
}

/** While /info has no heights yet, what the node's log says it is busy with. */
function startupPhase(info: NodeInfo): NodePhase | null {
  const st = info.startup
  if (!st || info.fullHeight !== null) return null
  if (st.restore) {
    const r = st.restore
    const of = r.target !== null ? ` of ${n(r.target)}` : ''
    const rate = r.blocksPerHour !== null ? ` About ${r.blocksPerHour >= 10 ? Math.round(r.blocksPerHour) : r.blocksPerHour.toFixed(1)} blocks/hour` : ''
    const eta = rate && r.etaSeconds !== null ? `, ${durationText(r.etaSeconds)} left.` : rate ? '.' : ''
    return {
      tone: 'busy',
      text:
        `Node is starting up: restoring state, block ${n(r.block)}${of} (don't close the launcher).${rate}${eta}` +
        indexerText(st)
    }
  }
  if (st.readersPending && info.headersHeight === null) {
    return {
      tone: 'busy',
      text: `Node is starting up: loading its database before it reports heights (don't close the launcher).${indexerText(st)}`
    }
  }
  return null
}

export function nodePhase(input: NodePhaseInput): NodePhase | null {
  const { status, detail, info } = input
  if (input.copying) return null
  if (status === 'stopped' || status === 'crashed') {
    if (input.remote) return { tone: 'idle', text: 'Node not running: this computer is using a launcher on another machine' }
    if (!input.installed) return { tone: 'idle', text: 'Node not running: install Java and the Ergo node first' }
    if (detail) return { tone: status === 'crashed' ? 'error' : 'warn', text: `Node not running: ${detail}` }
    return { tone: status === 'crashed' ? 'error' : 'idle', text: status === 'crashed' ? 'Node not running: it exited unexpectedly. See the Ergo node log.' : 'Node not running' }
  }
  if (status === 'starting') return { tone: 'busy', text: `Starting the node${detail ? `: ${detail}` : ''}` }
  if (status === 'stopping') {
    return { tone: 'busy', text: "Stopping the node safely… It closes its databases first (up to 2 minutes); don't close the launcher." }
  }

  if (!info) {
    return { tone: 'warn', text: 'Node API not responding yet: the node is running but has not answered /info' }
  }
  if (info.apiError) {
    const ago = info.answeredAt ? ` (last answer ${minutes(input.now - info.answeredAt)} ago)` : ''
    return { tone: 'error', text: `Node API not responding${ago}: ${info.apiError}` }
  }
  const starting = startupPhase(info)
  if (starting) return starting
  const headers = info.headersHeight ?? 0
  const blocks = info.fullHeight ?? 0
  const indexed = info.indexedHeight ?? 0
  const target = Math.max(info.maxPeerHeight ?? 0, headers)

  if (info.peersCount === 0) return { tone: 'busy', text: 'Looking for peers (none connected yet)' }
  if (!info.maxPeerHeight) {
    if (headers > 0) {
      return { tone: 'busy', text: `Downloading headers: ${n(headers)} so far (peers have not reported the chain height yet)` }
    }
    const peers = info.peersCount === 1 ? '1 peer' : `${n(info.peersCount)} peers`
    const waited = input.noHeightSince === null ? 0 : input.now - input.noHeightSince
    if (waited >= HEIGHT_STALL_MS) {
      return {
        tone: 'warn',
        text: `Connected to ${peers}, but none has reported the chain height in ${minutes(waited)}. Headers are not downloading. Copy the diagnostics and check the Ergo node log.`
      }
    }
    return { tone: 'busy', text: `Connected to ${peers}, waiting for them to report the chain height` }
  }
  if (headers < target - SLACK) return { tone: 'busy', text: `Downloading headers ${n(headers)} of ${n(target)}` }
  if (blocks < headers - SLACK) return { tone: 'busy', text: `Downloading blocks ${n(blocks)} of ${n(headers)}` }
  if (indexed < blocks - SLACK) {
    const ix = info.startup?.indexer
    const from = info.indexedHeight === null && ix ? ix.block : indexed
    return { tone: 'busy', text: `Indexing ${n(from)} of ${n(blocks)}` }
  }
  return { tone: 'ok', text: `Synced at height ${n(blocks)}` }
}
