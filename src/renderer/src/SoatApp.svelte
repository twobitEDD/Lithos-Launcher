<script lang="ts">
  import { onMount } from 'svelte'
  import { legacyRunning, type MinerStatus } from '@shared/soatMiner'
  import { errorText, setMinerAutoStart, startMiner, stopMiner, switchMinerService, ui } from './lib/store.svelte'

  // The standalone SOAT Miner window, in the look of the old soat-launcher.py. It only shows the
  // background service and sends it Start/Stop; closing it leaves mining running.
  let loadError = $state<string | null>(null)

  onMount(() => {
    const api = window.lithos
    const off = api.onMiner((s) => (ui.miner = s))
    api.getMiner().then(
      (s) => (ui.miner = s),
      (err: unknown) => (loadError = errorText(err))
    )
    return off
  })

  const BADGE: Record<MinerStatus, { text: string; kind: 'ok' | 'wait' | 'bad' }> = {
    running: { text: 'Mining', kind: 'ok' },
    starting: { text: 'Starting', kind: 'wait' },
    waiting: { text: 'Waiting', kind: 'wait' },
    restarting: { text: 'Restarting', kind: 'bad' },
    stopping: { text: 'Stopping', kind: 'wait' },
    stopped: { text: 'Stopped', kind: 'bad' }
  }

  const m = $derived(ui.miner)
  const svc = $derived(m.service)
  const legacy = $derived(svc?.legacy ?? null)
  const legacyOn = $derived(legacyRunning(legacy))
  const badge = $derived(legacyOn ? { text: 'Legacy', kind: 'wait' as const } : BADGE[m.status])
  const c = $derived(m.checks)
  const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'))
  const hash = $derived(m.sample ? `${m.sample.mhs.toFixed(2)} MH/s` : m.status === 'running' ? 'hashing…' : '—')
  const serviceText = $derived(
    !svc
      ? '—'
      : svc.reachable
        ? svc.mode === 'systemd'
          ? 'lithos-soat.service active'
          : 'background process'
        : legacy
          ? 'not started (old SOAT setup present)'
          : svc.installed
            ? 'not answering'
            : 'not installed'
  )
  const reason = $derived(
    m.status === 'running'
      ? `Mining${m.target ? ` → ${m.target.host}:${m.target.port}` : ''}. Closing this window does not stop the miner.`
      : (m.detail ?? (m.status === 'stopped' ? 'Stopped. Press Start, or turn on auto-start.' : ''))
  )
  let switching = $state(false)
  async function switchService(): Promise<void> {
    switching = true
    try {
      await switchMinerService()
    } finally {
      switching = false
    }
  }
</script>

<main class="soat">
  <header>
    <h1>SOAT Miner</h1>
    <span class="badge {badge.kind}">{badge.text}</span>
  </header>
  <p class="sub">
    Mining runs in the background SOAT service and starts when the Ergo node is close enough to the tip and the Lithos
    Client has a job on its stratum. Closing this window or Lithos Launcher does not stop it.
  </p>

  {#if legacy}
    <div class="legacy" role="status">
      <span>Legacy SOAT service is {legacyOn ? 'running' : 'enabled'}.</span>
      <button class="primary" onclick={switchService} disabled={switching}>
        {switching ? 'Switching…' : 'Switch to Lithos service'}
      </button>
    </div>
  {/if}

  <section class="card">
    <span class="key">Ergo node</span><span class="key">fullHeight</span><span class="metric"
      >{c ? (c.node ? fmt(c.node.fullHeight) : 'down') : '—'}</span
    >
    <span></span><span class="key">headersHeight</span><span class="metric"
      >{c ? (c.node ? fmt(c.node.headersHeight) : 'down') : '—'}</span
    >
    <span></span><span class="key">Gap</span><span class="metric">{fmt(c?.gap)}</span>
    <span></span><span class="key">peers</span><span class="metric">{c?.node ? fmt(c.node.peers) : '—'}</span>
    <span class="key">Lithos stratum</span><span></span><span class="metric"
      >{c ? (c.stratumListening ? 'up' : 'down') : m.remote ? 'LAN launcher' : '—'}</span
    >
    <span class="key">Lithos panel</span><span></span><span class="metric">{c ? (c.panelUp ? 'up' : 'down') : '—'}</span>
    <span class="key">Client job</span><span></span><span class="metric"
      >{c ? (c.work === 'ready' ? 'yes' : c.work === 'none' ? 'not yet' : 'unknown') : '—'}</span
    >
    <span class="key">Service</span><span></span><span class="metric">{serviceText}</span>
    <span class="key">Hashrate</span><span></span><span class="metric">{hash}</span>
    <span></span><span class="key">Accepted</span><span class="metric">{fmt(m.sample?.accepted)}</span>
    <span class="key">Restarts</span><span></span><span class="metric">{m.restarts}</span>
  </section>

  <p class="reason">{reason}</p>
  {#if loadError || ui.minerError || svc?.error}
    <p class="error" role="alert">{loadError ?? ui.minerError ?? svc?.error}</p>
  {/if}

  <div class="row">
    <label>
      <input type="checkbox" checked={m.autoStart} onchange={(e) => void setMinerAutoStart(e.currentTarget.checked)} />
      Auto-start when synced
    </label>
    <span class="grow"></span>
    <button class="primary" onclick={startMiner} disabled={legacyOn || m.status === 'running' || m.status === 'starting'}
      >Start</button
    >
    <button onclick={stopMiner} disabled={m.status === 'stopped' || m.status === 'stopping'}>Stop</button>
  </div>

  {#if m.logTail.length}
    <pre class="tail">{m.logTail.slice(-6).join('\n')}</pre>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #12141a;
  }

  .soat {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 100vh;
    box-sizing: border-box;
    padding: 18px 20px;
    background: #12141a;
    color: #e8eaef;
    font-family: 'Noto Sans', 'Inter Variable', sans-serif;
    font-size: 13px;
  }

  header {
    display: flex;
    align-items: center;
  }

  h1 {
    flex: 1;
    margin: 0;
    font-size: 22px;
    font-weight: 700;
  }

  .badge {
    min-width: 92px;
    padding: 4px 12px;
    border-radius: 999px;
    font-weight: 700;
    text-align: center;
  }

  .badge.ok {
    background: #143528;
    color: #3dd68c;
  }

  .badge.wait {
    background: #3a3016;
    color: #f0b429;
  }

  .badge.bad {
    background: #3a1518;
    color: #ff6b6b;
  }

  .sub {
    margin: 0;
    color: #8b93a7;
    font-size: 12px;
  }

  .legacy {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border: 1px solid #5a4a1c;
    border-radius: 10px;
    background: #3a3016;
    color: #f0b429;
  }

  .legacy span {
    flex: 1;
  }

  .card {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 10px 16px;
    padding: 16px;
    border: 1px solid #2a2f3c;
    border-radius: 12px;
    background: #1b1e27;
  }

  .key {
    color: #8b93a7;
  }

  .metric {
    font-family: 'JetBrains Mono', 'Noto Sans Mono', monospace;
    font-weight: 600;
  }

  .reason {
    margin: 0;
    padding: 4px 2px;
  }

  .error {
    margin: 0;
    color: #ff6b6b;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .row label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .grow {
    flex: 1;
  }

  button {
    min-width: 88px;
    padding: 8px 18px;
    border: 1px solid #3d4558;
    border-radius: 8px;
    background: #2a3142;
    color: #e8eaef;
    font-weight: 600;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: #343c52;
  }

  button.primary {
    border-color: #2f6b4a;
    background: #1e3d2e;
  }

  button:disabled {
    border-color: #2a2f3c;
    background: #1c2030;
    color: #5c6478;
    cursor: default;
  }

  .tail {
    margin: 0;
    max-height: 140px;
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid #2a2f3c;
    border-radius: 8px;
    background: #0b0d12;
    color: #8b93a7;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
