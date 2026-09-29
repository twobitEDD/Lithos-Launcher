<script lang="ts">
  import { fmtConfigDiff, fmtHashrate } from '@shared/mining'
  import { DEFAULT_REDUCTION_MULTIPLIER, type ProcStatus } from '@shared/types'
  import StatusDot from './StatusDot.svelte'
  import {
    clientRequirements,
    copyApiKey,
    copyText,
    openLithosPanel,
    setAutoStartClient,
    startClient,
    stopClient,
    ui
  } from './store.svelte'

  const STATUS_TEXT: Record<ProcStatus, string> = {
    stopped: 'Stopped',
    starting: 'Starting',
    running: 'Running',
    stopping: 'Stopping',
    crashed: 'Stopped unexpectedly'
  }

  let copied = $state<string | null>(null)
  let keyCopied = $state(false)

  const status = $derived(ui.client.status)
  const active = $derived(status === 'starting' || status === 'running' || status === 'stopping')
  const running = $derived(status === 'running')
  const shownNetwork = $derived(active && ui.client.network ? ui.client.network : ui.network)
  const requirements = $derived(clientRequirements())
  const ready = $derived(requirements.every((r) => r.ok))
  const settings = $derived(ui.clientSettings)
  const stats = $derived(running ? ui.clientStats : null)

  const lanHost = $derived(ui.lanAddresses[0] ?? null)
  const stratumPort = $derived(ui.client.ports?.stratum ?? null)
  const stratumUrl = $derived(stratumPort ? `stratum+tcp://${lanHost ?? '127.0.0.1'}:${stratumPort}` : null)
  const httpPort = $derived(ui.client.ports?.http ?? null)
  const lanPanelUrl = $derived(settings?.lanPanel && lanHost && httpPort ? `http://${lanHost}:${httpPort}/` : null)

  const hashrate = $derived(stats?.hashesPerSecond ? fmtHashrate(stats.hashesPerSecond).split(' ') : null)
  const score = (s: string | null): string => (s ? fmtConfigDiff(Number(s)) : '—')

  /** Where the on-chain commitment stands: a headline figure and one line under it. */
  const commitment = $derived.by((): { value: string; text: string; ok: boolean } => {
    if (stats?.committed && stats.pending) {
      return {
        value: score(stats.committed),
        text: `${score(stats.pending)} from block ${stats.pendingFromHeight ?? '?'}`,
        ok: true
      }
    }
    if (stats?.committed) return { value: score(stats.committed), text: 'Committed on chain', ok: true }
    if (stats?.pending) {
      return { value: score(stats.pending), text: `Takes effect at block ${stats.pendingFromHeight ?? '?'}`, ok: false }
    }
    if (settings?.autoCommit) return { value: '—', text: running ? 'Auto-commit on, registering…' : 'Auto-commit on', ok: false }
    return { value: '—', text: 'Not committed', ok: false }
  })

  /** The few things a newcomer must act on, instead of reading warnings in the log. */
  const warnings = $derived.by((): string[] => {
    if (!running) return []
    const list: string[] = []
    if (!settings?.autoCommit && !stats?.committed) {
      list.push('Mining, but not committed on chain: no payouts until you commit your difficulty.')
    }
    if (ui.wallet.network === ui.client.network && ui.wallet.balanceNanoErg === 0) {
      list.push('The wallet has no ERG. Each proof needs a small refundable bond, so fund it before you commit.')
    }
    if (stats && stats.rigs === 0) list.push('No mining rigs connected yet.')
    if (stats && stats.rigs > 0 && !stats.hashesPerSecond && (settings?.reductionMultiplier ?? DEFAULT_REDUCTION_MULTIPLIER) >= 10000) {
      list.push(
        'Rig connected, no hashrate yet: with super-shares-only reporting a reading can take a while. Adjust Share reporting to 100× for a quicker one.'
      )
    }
    if (stats?.forcedConfig) list.push('Test mode (forceConfigDiff) is on: proofs at an uncommitted difficulty are rejected.')
    return list
  })

  async function copy(text: string): Promise<void> {
    await copyText(text)
    copied = text
    setTimeout(() => (copied = null), 1500)
  }

  async function copyKey(): Promise<void> {
    const network = ui.client.network
    if (!network) return
    ui.clientError = await copyApiKey(network, 'lithos')
    if (ui.clientError) return
    keyCopied = true
    setTimeout(() => (keyCopied = false), 1500)
  }
</script>

<section class="panel" aria-labelledby="client-title">
  <div class="panel-head">
    <h2 class="card-title" id="client-title">
      <span class="swatch lithos" aria-hidden="true"></span>Lithos Client<span class="no">04</span>
    </h2>
    <div class="head-right">
      <label class="check small">
        <input
          type="checkbox"
          checked={ui.autoStartClient}
          onchange={(e) => setAutoStartClient(e.currentTarget.checked)}
        />
        Start when ready
      </label>
      <span class="net micro {shownNetwork}">{shownNetwork}</span>
    </div>
  </div>

  <div class="body">
    <div class="top">
      <div class="status">
        <StatusDot {status} size={10} />
        <div>
          <div class="status-text">{STATUS_TEXT[status]}</div>
          {#if ui.client.detail}
            <div class="detail">{ui.client.detail}</div>
          {/if}
        </div>
      </div>
      <div class="actions">
        {#if active}
          <button class="btn danger" onclick={stopClient} disabled={status === 'stopping'}>
            {status === 'stopping' ? 'Stopping…' : 'Stop client'}
          </button>
        {:else}
          <button class="btn primary" onclick={startClient} disabled={!ready}>Start client</button>
        {/if}
        <button class="btn" onclick={openLithosPanel} disabled={!running}>Lithos panel ↗</button>
      </div>
    </div>

    {#if running}
      <div class="tiles">
        <div class="tile">
          <span class="tile-name"><span class="swatch you" aria-hidden="true"></span>Your hashrate</span>
          <span class="tile-value num">
            {#if hashrate}{hashrate[0]}<span class="unit you">{hashrate[1]}</span>{:else}—{/if}
          </span>
          <span class="tile-sub">
            {stats?.rigs ?? 0} rig{stats?.rigs === 1 ? '' : 's'} connected ·
            <button class="link" onclick={() => (ui.dialog = 'miner')}>Connect a miner</button>
          </span>
        </div>
        <div class="tile">
          <span class="tile-name"><span class="swatch lithos" aria-hidden="true"></span>Super shares</span>
          <span class="tile-value num"><span class="flow-word">{stats?.superShares ?? 0}</span></span>
          <span class="tile-sub">
            {stats?.superSharesPerHour ? `${stats.superSharesPerHour.toFixed(1)} per hour` : 'this session'}
          </span>
        </div>
        <div class="tile">
          <span class="tile-name"><span class="swatch network" aria-hidden="true"></span>Commitment</span>
          <span class="tile-value num">{commitment.value}</span>
          <span class="tile-sub" class:ok={commitment.ok} class:warn={!commitment.ok}>
            {commitment.text} ·
            <button class="link" onclick={() => (ui.dialog = 'commit')}>
              {settings?.autoCommit ? 'Details' : 'Commit…'}
            </button>
          </span>
        </div>
      </div>
    {/if}

    <div class="chips">
      <div class="chip">
        <span class="micro">Difficulty</span>
        <span class="val num">{settings?.diff ?? 'not set'}</span>
        <button class="link micro" onclick={() => (ui.dialog = 'difficulty')}>{settings?.diff ? 'Change' : 'Choose'}</button>
      </div>
      <div class="chip">
        <span class="micro">Share reporting</span>
        <span class="val num">{(settings?.reductionMultiplier ?? DEFAULT_REDUCTION_MULTIPLIER).toLocaleString('en-US')}×</span>
        <button class="link micro" onclick={() => (ui.dialog = 'shares')}>Adjust</button>
      </div>
      {#if !running}
        <div class="chip">
          <span class="micro">Commitment</span>
          <span class="val" class:ok={commitment.ok} class:warn={!commitment.ok}>{commitment.text}</span>
          <button class="link micro" onclick={() => (ui.dialog = 'commit')}>
            {settings?.autoCommit ? 'Details' : 'Commit…'}
          </button>
        </div>
      {/if}
    </div>

    {#if running && stratumUrl}
      <div class="endpoint well">
        <span class="micro">Stratum</span>
        <code class="mono" title={ui.lanAddresses.join(', ')}>{stratumUrl}</code>
        <button class="btn small" onclick={() => copy(stratumUrl!)}>{copied === stratumUrl ? 'Copied' : 'Copy'}</button>
      </div>
      {#if lanPanelUrl}
        <div class="endpoint well">
          <span class="micro">Panel on LAN</span>
          <code class="mono lan">{lanPanelUrl}</code>
          <button class="btn small" onclick={() => copy(lanPanelUrl!)}>{copied === lanPanelUrl ? 'Copied' : 'Copy'}</button>
        </div>
      {/if}
      <div class="endpoint well" title="Copied without being shown. The clipboard clears itself after 30 seconds.">
        <span class="micro">API key</span>
        <span class="secret">
          <span class="dots mono" aria-hidden="true">••••••••••••</span>
          <span class="for">for the panel's DEX and collateral market</span>
        </span>
        <button class="btn small" onclick={copyKey}>{keyCopied ? 'Copied' : 'Copy'}</button>
      </div>
    {:else if !active}
      <ul class="reqs" aria-label="Requirements">
        {#each requirements as r (r.label)}
          <li class:ok={r.ok}>
            <span class="tick" aria-hidden="true">{r.ok ? '✓' : ''}</span>
            {r.label}
            {#if r.note}<span class="req-note">{r.note}</span>{/if}
            <span class="sr-only">{r.ok ? 'done' : 'not yet'}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if warnings.length}
      <ul class="warnings warn-note">
        {#each warnings as w (w)}<li>{w}</li>{/each}
      </ul>
    {/if}
  </div>

  {#if ui.clientError && ui.clientError !== ui.client.detail}
    <p class="error-text client-error" role="alert">{ui.clientError}</p>
  {/if}
</section>

<style>
  .head-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .check.small {
    font-size: 11.5px;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 20px 18px;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    flex-wrap: wrap;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .status-text {
    color: var(--text-head);
    font-family: var(--display);
    font-size: 21px;
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

  /* Live figures as Mining-page stat tiles, each marked with its colour role. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--well);
  }

  .tile-name {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .tile-name .swatch {
    width: 8px;
    height: 8px;
    box-shadow: none;
  }

  .tile-value {
    color: var(--text-head);
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1.05;
    white-space: nowrap;
  }

  .unit {
    margin-left: 4px;
    font-size: 0.45em;
    font-weight: 600;
    letter-spacing: 0;
  }

  .unit.you {
    color: var(--amber-light);
  }

  .tile-sub {
    color: var(--faint);
    font-size: 11px;
    line-height: 1.45;
  }

  .tile-sub .link {
    font-size: 11px;
  }

  .ok {
    color: var(--mint);
  }

  .warn {
    color: var(--amber-light);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 10px;
    border: 1px solid rgba(125, 211, 252, 0.12);
    border-radius: var(--radius-sm);
    background: rgba(10, 15, 30, 0.6);
    font-size: 12px;
  }

  .chip .micro {
    font-size: 9.5px;
  }

  .val {
    color: var(--text-head);
    font-weight: 600;
  }

  .val.ok {
    color: var(--mint);
  }

  .val.warn {
    color: var(--amber-light);
  }

  .reqs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--dim);
    font-size: 12px;
  }

  .reqs li {
    display: flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }

  .reqs li.ok {
    color: var(--text);
  }

  .tick {
    display: grid;
    place-items: center;
    width: 15px;
    height: 15px;
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    color: #04111f;
    font-size: 10px;
    font-weight: 700;
  }

  .ok .tick {
    border-color: var(--mint);
    background: var(--mint);
  }

  .req-note {
    color: var(--amber);
    font-family: var(--mono);
    font-size: 10.5px;
  }

  .endpoint {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 7px 8px 7px 12px;
  }

  code {
    overflow: hidden;
    color: var(--sky-light);
    font-size: 12.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  code.lan {
    color: var(--purple-light);
  }

  .secret {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .dots {
    color: var(--purple-light);
    font-size: 12.5px;
    letter-spacing: 0.1em;
  }

  .for {
    overflow: hidden;
    color: var(--faint);
    font-size: 11.5px;
    text-overflow: ellipsis;
  }

  .warnings {
    padding-left: 28px;
  }

  .warnings li + li {
    margin-top: 2px;
  }

  .client-error {
    margin: 0 20px 18px;
  }
</style>
