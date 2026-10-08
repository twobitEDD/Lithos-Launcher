<script lang="ts">
  import { lanPeerLabel } from '@shared/lanPeers'
  import { syncView, type SyncStage } from '@shared/sync'
  import type { ProcStatus } from '@shared/types'
  import Ring from './Ring.svelte'
  import StatusDot from './StatusDot.svelte'
  import SyncDetails from './SyncDetails.svelte'
  import SyncPanel from './SyncPanel.svelte'
  import {
    copyApiKey,
    errorText,
    openNodePanel,
    setAutoStartNode,
    setLanPeering,
    startNode,
    startOnThisComputer,
    stopNode,
    ui,
    useOtherLauncher
  } from './store.svelte'

  const STATUS_TEXT: Record<ProcStatus, string> = {
    stopped: 'Stopped',
    starting: 'Starting',
    running: 'Running',
    stopping: 'Stopping',
    crashed: 'Stopped unexpectedly'
  }

  const RING_CAPTION: Record<SyncStage, string> = {
    connecting: 'peers',
    headers: 'syncing',
    blocks: 'syncing',
    indexing: 'indexing',
    synced: 'synced'
  }

  const status = $derived(ui.node.status)
  const active = $derived(status === 'starting' || status === 'running' || status === 'stopping')
  // While a node runs, this card follows it even if the switch shows the other network.
  const shownNetwork = $derived(active && ui.node.network ? ui.node.network : ui.network)
  const otherNetwork = $derived(active && ui.node.network !== null && ui.node.network !== ui.network)
  const installed = $derived(ui.net?.java.installed && ui.net?.node.installed)
  const view = $derived(ui.info ? syncView(ui.info) : null)
  const lanText = $derived(lanPeerLabel(ui.lanPeers))
  // Headers, blocks and index weigh the same: the node is ready for Lithos when all three are done.
  const overall = $derived(
    view && view.stage !== 'connecting' && view.target > 0
      ? view.stage === 'synced'
        ? 1
        : (view.headers + view.blocks + view.indexed) / (3 * view.target)
      : null
  )

  let keyCopied = $state(false)
  /** Extra sync explanation stays closed so the card does not grow on its own. */
  let detailsOpen = $state(false)

  async function copyKey(): Promise<void> {
    const network = ui.node.network
    if (!network) return
    ui.nodeError = await copyApiKey(network, 'node')
    if (ui.nodeError) return
    keyCopied = true
    setTimeout(() => (keyCopied = false), 1500)
  }

  async function stopStray(): Promise<void> {
    ui.nodeError = null
    try {
      await window.lithos.stopStrayNode(ui.network)
    } catch (err) {
      ui.nodeError = errorText(err)
    }
  }
</script>

<section class="panel" aria-labelledby="node-title">
  <div class="panel-head">
    <h2 class="card-title" id="node-title">
      <span class="swatch network" aria-hidden="true"></span>Ergo node<span class="no">02</span>
    </h2>
    <div class="head-right">
      <label class="check small" title="Start the node, or use one already running, when the launcher opens">
        <input
          type="checkbox"
          checked={ui.autoStartNode}
          onchange={(e) => void setAutoStartNode(e.currentTarget.checked)}
        />
        Start on launch
      </label>
      <span class="net micro {shownNetwork}">{shownNetwork}</span>
    </div>
  </div>

  <div class="status">
    <StatusDot {status} size={10} />
    <div class="status-body">
      <div class="status-text">{STATUS_TEXT[status]}</div>
      {#if ui.node.detail}
        <div class="detail">{ui.node.detail}</div>
        {#if ui.node.stray}
          <button class="btn small stray" onclick={stopStray}>Stop it</button>
        {/if}
      {:else if otherNetwork}
        <div class="detail">Running on {ui.node.network}. Stop it to start {ui.network}.</div>
      {:else if status === 'stopped' && ui.remoteLauncher}
        <div class="detail">
          This computer is using a launcher on another machine at {ui.remoteLauncher.host}:{ui.remoteLauncher.port}. The
          node on this computer was not started because of that.
        </div>
      {:else if status === 'stopped' && !installed}
        <div class="detail">Install the components above first.</div>
      {:else if ui.info}
        <div class="detail micro">
          {ui.info.peersCount} peers{ui.info.appVersion ? ` · v${ui.info.appVersion}` : ''}
        </div>
      {/if}
    </div>
    {#if view}
      <Ring value={overall} caption={RING_CAPTION[view.stage]} done={view.stage === 'synced'} />
    {/if}
  </div>

  {#if status === 'stopped' && ui.remoteLauncher}
    <div class="here">
      <button class="btn primary" type="button" onclick={startOnThisComputer}>Start on this computer instead</button>
      <p class="detail">This does not shut down the launcher on the other machine.</p>
    </div>
  {/if}

  {#if !ui.remoteLauncher && ui.ignoredLaunchers.length}
    <p class="ignore-note">
      Ignoring the launcher at {ui.ignoredLaunchers.join(', ')}.
      <button class="link" type="button" onclick={useOtherLauncher}>Use the other launcher again</button>
    </p>
  {/if}

  <p class="lan-peers">
    {#if lanText}<span>{lanText}</span>{/if}
    <button class="link" type="button" onclick={() => void setLanPeering(!ui.lanPeers.enabled)}>
      {ui.lanPeers.enabled ? 'Turn off LAN peering' : 'Turn on LAN peering'}
    </button>
  </p>

  <SyncPanel />

  {#if status === 'running' && ui.info}
    <div class="sync-more">
      <button
        class="link"
        type="button"
        aria-expanded={detailsOpen}
        aria-controls="sync-details"
        onclick={() => (detailsOpen = !detailsOpen)}
      >
        {detailsOpen ? 'Hide sync details' : 'Sync details'}
      </button>
      {#if detailsOpen}
        <SyncDetails />
      {/if}
    </div>
  {/if}

  {#if status === 'running'}
    <div class="key well" title="Copied without being shown. The clipboard clears itself after 30 seconds.">
      <span class="micro">API key</span>
      <span class="dots mono" aria-hidden="true">••••••••••••</span>
      <button class="btn small" onclick={copyKey}>{keyCopied ? 'Copied' : 'Copy'}</button>
    </div>
  {/if}

  <div class="actions">
    {#if active}
      <button class="btn danger" onclick={stopNode} disabled={status === 'stopping'}>
        {status === 'stopping' ? 'Stopping…' : 'Stop node'}
      </button>
    {:else}
      <button class="btn primary" onclick={startNode} disabled={!installed || ui.remoteLauncher !== null}>Start node</button>
    {/if}
    <button class="btn" onclick={openNodePanel} disabled={status !== 'running'}>Node panel ↗</button>
  </div>

  {#if ui.nodeError && ui.nodeError !== ui.node.detail}
    <p class="error-text node-error" role="alert">{ui.nodeError}</p>
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

  .status {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 20px 14px;
  }

  .status-body {
    flex: 1;
    min-width: 0;
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

  .detail.micro {
    color: var(--dim);
  }

  .stray {
    margin-top: 8px;
  }

  .here {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 20px 4px;
  }

  .here .detail {
    margin: 0;
  }

  .ignore-note {
    margin: 0 20px 12px;
    color: var(--muted);
    font-size: 12px;
  }

  .ignore-note .link {
    margin-left: 6px;
  }

  .lan-peers {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 10px;
    margin: 0 20px 12px;
    color: var(--muted);
    font-size: 12px;
  }

  .sync-more {
    margin: 8px 20px 0;
  }

  .key {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    margin: 12px 20px 0;
    padding: 7px 8px 7px 14px;
  }

  .dots {
    color: var(--sky-light);
    font-size: 12.5px;
    letter-spacing: 0.1em;
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 14px 20px 20px;
  }

  .node-error {
    margin: 0 20px 20px;
  }
</style>
