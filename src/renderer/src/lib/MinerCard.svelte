<script lang="ts">
  import type { MinerStatus } from '@shared/soatMiner'
  import type { ProcStatus } from '@shared/types'
  import StatusDot from './StatusDot.svelte'
  import { legacyRunning } from '@shared/soatMiner'
  import { setMinerAutoStart, startMiner, stopMiner, switchMinerService, ui } from './store.svelte'

  const STATUS_TEXT: Record<MinerStatus, string> = {
    stopped: 'Stopped',
    waiting: 'Waiting',
    starting: 'Starting',
    running: 'Mining',
    restarting: 'Restarting',
    stopping: 'Stopping'
  }
  const DOT: Record<MinerStatus, ProcStatus> = {
    stopped: 'stopped',
    waiting: 'starting',
    starting: 'starting',
    running: 'running',
    restarting: 'crashed',
    stopping: 'stopping'
  }

  const m = $derived(ui.miner)
  const active = $derived(m.status !== 'stopped')
  const backendText = $derived(m.backend === 'cuda' ? 'CUDA' : m.backend === 'vulkan' ? 'Vulkan' : null)
  const targetText = $derived(m.target ? `${m.target.host}:${m.target.port}${m.remote ? ' (other launcher)' : ''}` : '—')
  const binaryText = $derived(
    m.source
      ? `${m.version ? `v${m.version}` : 'SOAT'} · ${m.source === 'launcher' ? 'installed by the launcher' : 'existing install'}`
      : '—'
  )
  const installPct = $derived(m.install && m.install.total > 0 ? Math.round((100 * m.install.received) / m.install.total) : null)
  let showLog = $state(false)
  const tail = $derived(showLog ? m.logTail : m.logTail.slice(-4))

  const svc = $derived(m.service)
  const legacy = $derived(svc?.legacy ?? null)
  const legacyOn = $derived(legacyRunning(legacy))
  const serviceText = $derived(
    !svc
      ? '—'
      : svc.reachable
        ? `Running${svc.mode === 'systemd' ? ' (systemd)' : svc.mode === 'detached' ? ' (background)' : ''}`
        : legacy
          ? 'Not started (old SOAT setup present)'
          : svc.installed
            ? 'Not answering'
            : 'Not installed'
  )
  const checks = $derived(m.checks)
  const nodeText = $derived(
    !checks ? '—' : !checks.node ? 'down' : checks.gap === null ? 'syncing' : `gap ${checks.gap.toLocaleString('en-US')}`
  )
  const jobText = $derived(
    !checks ? '—' : checks.work === 'ready' ? 'has a job' : checks.work === 'none' ? 'no job yet' : 'unknown'
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

<section class="panel" aria-labelledby="miner-title">
  <div class="panel-head">
    <h2 class="card-title" id="miner-title">
      <span class="swatch you" aria-hidden="true"></span>SOAT miner<span class="no">05</span>
    </h2>
    <div class="head-right">
      <label
        class="check small"
        title="Mine once the node and Lithos Client are ready, and restart the miner if it stops. Runs in the background SOAT service, so closing this window does not stop mining."
      >
        <input type="checkbox" checked={m.autoStart} onchange={(e) => void setMinerAutoStart(e.currentTarget.checked)} />
        Auto-start and keep running
      </label>
      {#if backendText}<span class="micro backend">{backendText}</span>{/if}
    </div>
  </div>

  <div class="body">
    <div class="top">
      <div class="status">
        <StatusDot status={DOT[m.status]} size={10} />
        <div class="status-body">
          <div class="status-text">{STATUS_TEXT[m.status]}</div>
          {#if m.detail}
            <div class="detail">{m.detail}{installPct !== null ? ` (${installPct}%)` : ''}</div>
          {:else if m.status === 'running' && m.gpu}
            <div class="detail">{m.gpu}</div>
          {/if}
        </div>
      </div>
      <div class="actions">
        {#if active}
          <button class="btn danger" onclick={stopMiner} disabled={m.status === 'stopping'}>
            {m.status === 'stopping' ? 'Stopping…' : 'Stop miner'}
          </button>
        {:else}
          <button
            class="btn primary"
            onclick={startMiner}
            disabled={legacyOn}
            title={legacyOn ? 'Switch to the Lithos service first, so two miners never share the GPU' : undefined}
          >
            Start miner
          </button>
        {/if}
      </div>
    </div>

    {#if legacy}
      <div class="legacy" role="status">
        <span>
          Legacy SOAT service is {legacyOn ? 'running' : 'enabled'}
          {#if legacy.activeUnits.length || legacy.enabledUnits.length}
            <span class="mono">({[...new Set([...legacy.activeUnits, ...legacy.enabledUnits])].join(', ')})</span>
          {/if}
          — mining stays with it until you switch.
        </span>
        <button class="btn primary" onclick={switchService} disabled={switching}>
          {switching ? 'Switching…' : 'Switch to Lithos service'}
        </button>
      </div>
    {/if}

    <dl class="facts">
      <div>
        <dt class="micro">Hashrate</dt>
        <dd class="num">{m.lastHashLine ?? '—'}</dd>
      </div>
      <div>
        <dt class="micro">Restarts</dt>
        <dd class="num">{m.restarts}</dd>
      </div>
      <div>
        <dt class="micro">Stratum</dt>
        <dd class="mono">{targetText}</dd>
      </div>
      <div>
        <dt class="micro">Worker</dt>
        <dd class="mono">{m.worker || '—'}</dd>
      </div>
      <div>
        <dt class="micro">Binary</dt>
        <dd>{binaryText}</dd>
      </div>
    </dl>
    <dl class="facts checks">
      <div>
        <dt class="micro">Service</dt>
        <dd>{serviceText}</dd>
      </div>
      <div>
        <dt class="micro">Node</dt>
        <dd class="num">{nodeText}</dd>
      </div>
      <div>
        <dt class="micro">Panel</dt>
        <dd>{checks ? (checks.panelUp ? 'up' : 'down') : '—'}</dd>
      </div>
      <div>
        <dt class="micro">Stratum</dt>
        <dd>{checks ? (checks.stratumListening ? 'listening' : 'down') : '—'}</dd>
      </div>
      <div>
        <dt class="micro">Client job</dt>
        <dd>{jobText}</dd>
      </div>
    </dl>
    {#if svc?.error}
      <p class="error-text" role="alert">{svc.error}</p>
    {/if}

    {#if m.logTail.length}
      <div class="log-head">
        <span class="micro">Miner log</span>
        {#if m.logTail.length > 4}
          <button class="link micro" onclick={() => (showLog = !showLog)}>{showLog ? 'Less' : 'More'}</button>
        {/if}
      </div>
      <pre class="tail mono">{tail.join('\n')}</pre>
    {/if}

    {#if ui.minerError}
      <p class="error-text" role="alert">{ui.minerError}</p>
    {/if}
  </div>
</section>

<style>
  .head-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .backend {
    color: var(--sky-light);
  }

  .body {
    padding: 0 20px 16px;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .status {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }

  .status-body {
    min-width: 0;
  }

  .status-text {
    color: var(--text-head);
    font-family: var(--display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }

  .detail {
    margin-top: 2px;
    color: var(--muted);
    font-size: 12px;
  }

  .actions {
    display: flex;
    gap: 10px;
  }

  .facts {
    display: grid;
    grid-template-columns: 2fr 0.6fr 1.3fr 1fr 1.5fr;
    gap: 10px;
    margin: 12px 0 0;
  }

  .facts div {
    min-width: 0;
  }

  .facts.checks {
    grid-template-columns: 1.6fr 1fr 0.8fr 1fr 1fr;
    margin-top: 8px;
  }

  .legacy {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
    padding: 8px 12px;
    border: 1px solid #5a4a1c;
    border-radius: var(--radius);
    background: #3a3016;
    color: #f0b429;
    font-size: 12px;
  }

  .legacy span {
    flex: 1;
  }

  .facts dd {
    margin: 2px 0 0;
    overflow: hidden;
    color: var(--text);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .log-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-top: 12px;
  }

  .tail {
    margin: 4px 0 0;
    max-height: 190px;
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #050811;
    color: var(--dim);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .error-text {
    margin: 10px 0 0;
  }
</style>
