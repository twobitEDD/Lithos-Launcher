import type { ProcId } from '@shared/types'

const NAME: Record<ProcId, string> = { node: 'The Ergo node', client: 'The Lithos Client' }

/**
 * A plain-language reason for a failed start or unexpected exit, read from the process's last
 * output, or null when nothing recognisable is there (the log tab still has everything).
 */
export function diagnose(id: ProcId, lines: string[]): string | null {
  const recent = lines.slice(-400)
  const text = recent.join('\n')

  const missing = /Corruption: (\d+) missing files/.exec(text)
  if (missing) {
    return `The node's database is damaged: ${missing[1]} of its files are missing. Delete the node's data folder so it can sync again, or restore it from a copy.`
  }
  if (id === 'node' && /DBException: Corruption|Failed to initialize storage/.test(text)) {
    return "The node's database is damaged. Delete the node's data folder so it can sync again, or restore it from a copy."
  }
  if (/OutOfMemoryError|Java heap space/.test(text)) {
    return `${NAME[id]} ran out of memory. Give it more in Settings, under Memory.`
  }
  if (/No space left on device|not enough space on the disk/i.test(text)) {
    return 'The disk is full. Free some space, then start it again.'
  }
  if (/BindException|Address already in use/.test(text)) {
    return `${NAME[id]} could not open one of its ports because another program is using it.`
  }
  if (/lock hold by current process|IO error: lock|LOCK: The process cannot access/i.test(text)) {
    return "Another program is using the node's data folder. Is an old node still running?"
  }
  if (id === 'client') {
    // The client explains bad settings on the lines after this exception.
    const at = recent.findIndex((l) => l.includes('ConfigValidationException'))
    if (at !== -1) {
      const reason: string[] = []
      for (const line of recent.slice(at, at + 12)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('at ') || /ConfigValidationException/.test(trimmed)) continue
        if (/^[\w.$]+(Exception|Error)\b/.test(trimmed)) break
        reason.push(trimmed)
      }
      if (reason.length) return `The Lithos Client rejected its settings: ${reason.join(' ')}`
    }
  }
  return null
}
