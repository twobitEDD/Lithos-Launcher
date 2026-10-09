<script lang="ts">
  import { onMount } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import type { LogChunk, ProcId } from '@shared/types'

  let {
    proc,
    visible,
    onlines,
    onfollow,
    oncopied
  }: {
    proc: ProcId
    visible: boolean
    onlines?: (count: number) => void
    /** False while the user has scrolled up; new output then leaves the view where it is. */
    onfollow?: (following: boolean) => void
    /** A selection was copied (Ctrl+C or right-click). */
    oncopied?: (chars: number) => void
  } = $props()

  let host: HTMLDivElement
  let fit: FitAddon | null = null
  let term: Terminal | null = null

  /** Jumps to the newest line and follows new output again. */
  export function scrollToBottom(): void {
    term?.scrollToBottom()
    onfollow?.(true)
  }

  function atBottom(): boolean {
    if (!term) return true
    const buffer = term.buffer.active
    return buffer.viewportY >= buffer.baseY
  }

  async function copySelection(): Promise<boolean> {
    const text = term?.getSelection() ?? ''
    if (!text) return false
    await window.lithos.copyText(text).catch(() => undefined)
    oncopied?.(text.length)
    return true
  }

  const SKY = '\x1b[38;2;56;189;248m'
  const AMBER = '\x1b[38;2;245;158;11m'
  const RED = '\x1b[38;2;239;68;68m'
  const RESET = '\x1b[0m'

  /** Highlights launcher messages, warnings and errors in otherwise plain log lines. */
  function colorize(line: string): string {
    if (line.includes('\x1b[')) return line
    if (line.startsWith('[launcher] Warning')) return AMBER + line + RESET
    if (line.startsWith('[launcher]')) return SKY + line + RESET
    if (/\bERROR\b/.test(line)) return RED + line + RESET
    if (/\bWARN\b/.test(line)) return AMBER + line + RESET
    return line
  }

  onMount(() => {
    let disposed = false
    let nextSeq = 0
    let total = 0
    let ready = false
    const queued: LogChunk[] = []

    // Sequence numbers let the snapshot and live chunks overlap without duplicating lines.
    const write = (chunk: LogChunk): void => {
      if (!term) return
      const skip = nextSeq - chunk.start
      if (skip >= chunk.lines.length) return
      const lines = skip > 0 ? chunk.lines.slice(skip) : chunk.lines
      nextSeq = chunk.start + chunk.lines.length
      total += lines.length
      const follow = atBottom()
      term.write(lines.map(colorize).join('\r\n') + '\r\n', () => {
        if (follow) term?.scrollToBottom()
      })
      onlines?.(total)
    }
    const reportFollow = (): void => onfollow?.(atBottom())

    const unsubscribe = window.lithos.onLogs((chunk) => {
      if (chunk.proc !== proc) return
      if (ready) write(chunk)
      else queued.push(chunk)
    })

    const observer = new ResizeObserver(() => {
      if (host.offsetParent !== null) fit?.fit()
    })

    // Wait for the mono font so xterm measures character cells correctly.
    void document.fonts.load('12px "JetBrains Mono"').finally(async () => {
      if (disposed) return
      term = new Terminal({
        disableStdin: true,
        cursorBlink: false,
        cursorStyle: 'bar',
        cursorInactiveStyle: 'none',
        scrollback: 3000,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 12,
        lineHeight: 1.3,
        theme: {
          background: '#050811',
          foreground: '#cbd5e1',
          cursor: '#050811',
          selectionBackground: 'rgba(56, 189, 248, 0.25)',
          scrollbarSliderBackground: 'rgba(56, 189, 248, 0.15)',
          scrollbarSliderHoverBackground: 'rgba(56, 189, 248, 0.3)',
          scrollbarSliderActiveBackground: 'rgba(56, 189, 248, 0.4)'
        }
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      fit.fit()
      observer.observe(host)
      term.onScroll(reportFollow)
      host.addEventListener('wheel', () => requestAnimationFrame(reportFollow), { passive: true })
      // Packaged builds have no Edit menu, so Ctrl+C / Cmd+C on a selection is handled here.
      term.attachCustomKeyEventHandler((event) => {
        const copyKey = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c'
        if (event.type === 'keydown' && copyKey && term?.hasSelection()) {
          void copySelection()
          return false
        }
        return true
      })
      host.addEventListener('contextmenu', (event) => {
        if (term?.hasSelection()) {
          event.preventDefault()
          void copySelection()
        }
      })

      write(await window.lithos.getLogs(proc))
      ready = true
      for (const chunk of queued) write(chunk)
      queued.length = 0
    })

    return () => {
      disposed = true
      unsubscribe()
      observer.disconnect()
      term?.dispose()
    }
  })

  $effect(() => {
    if (visible) requestAnimationFrame(() => fit?.fit())
  })
</script>

<div class="term" class:hidden={!visible} bind:this={host}></div>

<style>
  .term {
    position: absolute;
    inset: 10px 4px 10px 14px;
  }

  .hidden {
    display: none;
  }

  .term :global(.xterm-viewport) {
    background: transparent !important;
  }
</style>
