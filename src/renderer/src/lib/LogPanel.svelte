<script lang="ts">
  import type { ProcId } from '@shared/types'
  import StatusDot from './StatusDot.svelte'
  import Terminal from './Terminal.svelte'
  import { copyDiagnostics, copyLog, openLogsFolder, saveDiagnostics, ui } from './store.svelte'

  let tab = $state<ProcId>('node')
  let lines = $state<Record<ProcId, number>>({ node: 0, client: 0 })
  let following = $state<Record<ProcId, boolean>>({ node: true, client: true })
  let busy = $state<'copy' | 'diag' | 'save' | null>(null)
  const terms = $state.raw<Record<ProcId, Terminal | undefined>>({ node: undefined, client: undefined })

  const EMPTY: Record<ProcId, string> = {
    node: "The node's console output appears here once it starts.",
    client: "The Lithos Client's console output appears here once it starts."
  }

  async function run(which: 'copy' | 'diag' | 'save', fn: () => Promise<void>): Promise<void> {
    busy = which
    try {
      await fn()
    } finally {
      busy = null
    }
  }

  function copied(chars: number): void {
    ui.logNotice = { ok: true, text: `Copied the selection (${chars.toLocaleString('en-US')} characters).` }
  }
</script>

<section class="panel logs" aria-label="Process output">
  <div class="panel-head">
    <h2 class="card-title">Console</h2>
    <div class="tabs" role="tablist">
      <button
        role="tab"
        class="network"
        aria-selected={tab === 'node'}
        class:active={tab === 'node'}
        onclick={() => (tab = 'node')}
      >
        <StatusDot status={ui.node.status} size={7} />
        Ergo node
      </button>
      <button
        role="tab"
        class="lithos"
        aria-selected={tab === 'client'}
        class:active={tab === 'client'}
        onclick={() => (tab = 'client')}
      >
        <StatusDot status={ui.client.status} size={7} />
        Lithos Client
      </button>
    </div>
    <span class="spacer"></span>
    <span class="micro count">{lines[tab].toLocaleString('en-US')} lines</span>
  </div>

  <div class="toolbar">
    <button
      class="btn small"
      type="button"
      title="Copy every buffered line of this log (secrets masked). Select text and press Ctrl+C to copy just that."
      disabled={busy !== null}
      onclick={() => void run('copy', () => copyLog(tab))}>{busy === 'copy' ? 'Copying…' : 'Copy log'}</button
    >
    <button
      class="btn small"
      type="button"
      title="Launcher version, system, settings, node state, sync details, LAN chain copy and the last 500 lines of each log, with secrets masked"
      disabled={busy !== null}
      onclick={() => void run('diag', copyDiagnostics)}>{busy === 'diag' ? 'Collecting…' : 'Copy all diagnostics'}</button
    >
    <button class="btn small" type="button" disabled={busy !== null} onclick={() => void run('save', saveDiagnostics)}
      >{busy === 'save' ? 'Saving…' : 'Save diagnostics…'}</button
    >
    <button class="btn small" type="button" onclick={() => void openLogsFolder(tab)}>Open logs folder</button>
    {#if !following[tab]}
      <button class="btn small follow" type="button" onclick={() => terms[tab]?.scrollToBottom()}>Jump to latest ↓</button>
    {/if}
  </div>
  {#if ui.logNotice}
    <p class="notice" class:bad={!ui.logNotice.ok} role="status">{ui.logNotice.text}</p>
  {/if}

  <div class="screen">
    <Terminal
      bind:this={terms.node}
      proc="node"
      visible={tab === 'node'}
      onlines={(n) => (lines.node = n)}
      onfollow={(f) => (following.node = f)}
      oncopied={copied}
    />
    <Terminal
      bind:this={terms.client}
      proc="client"
      visible={tab === 'client'}
      onlines={(n) => (lines.client = n)}
      onfollow={(f) => (following.client = f)}
      oncopied={copied}
    />
    {#if lines[tab] === 0}
      <div class="empty">
        <span class="micro">No output yet</span>
        <p>{EMPTY[tab]}</p>
      </div>
    {/if}
  </div>
</section>

<style>
  /* Never squeezed to nothing: below this the page scrolls instead. */
  .logs {
    flex: 1 0 auto;
    display: flex;
    flex-direction: column;
    min-height: 320px;
  }

  .panel-head {
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: 10px 16px;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 12px 10px;
  }

  .follow {
    margin-left: auto;
    border-color: rgba(56, 189, 248, 0.4);
    color: var(--sky-light);
  }

  .notice {
    margin: 0 12px 10px;
    color: var(--mint);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .notice.bad {
    color: var(--red-light);
  }

  /* The Mining page's segmented control: a pill track, the chosen tab lit in its role's colour. */
  .tabs {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid rgba(125, 211, 252, 0.12);
    border-radius: 999px;
    background: rgba(10, 15, 30, 0.7);
  }

  [role='tab'] {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 13px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--dim);
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition:
      color 0.15s,
      background 0.15s;
  }

  [role='tab']:hover {
    color: var(--sky-light);
  }

  [role='tab'].network.active {
    background: rgba(56, 189, 248, 0.16);
    color: var(--sky-light);
    font-weight: 600;
  }

  [role='tab'].lithos.active {
    background: rgba(168, 85, 247, 0.18);
    color: var(--purple-light);
    font-weight: 600;
  }

  .spacer {
    flex: 1;
  }

  .screen {
    position: relative;
    flex: 1;
    min-height: 220px;
    margin: 0 12px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #050811;
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    pointer-events: none;
    text-align: center;
  }

  .empty p {
    margin: 0;
    color: var(--dim);
    font-size: 12.5px;
  }
</style>
