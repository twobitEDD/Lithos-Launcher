<script lang="ts">
  import { syncView } from '@shared/sync'
  import type { SyncPeerRow } from '@shared/types'
  import { fmtEta, fmtInt } from './format'
  import { ui } from './store.svelte'

  const details = $derived(ui.info?.syncDetails ?? null)
  const view = $derived(ui.info ? syncView(ui.info) : null)

  function historyLabel(peer: SyncPeerRow): string {
    if (peer.keepsNoFullBlocks) return 'reports no full blocks'
    if (peer.historyFrom === 1) return 'reports full blocks from the start'
    if (peer.historyFrom !== null) return `reports full blocks from ${fmtInt(peer.historyFrom)}`
    if (peer.fullBlocksSuffix !== null && peer.fullBlocksSuffix < -1) {
      return `does not report a full chain (suffix ${peer.fullBlocksSuffix})`
    }
    return 'saved-block range not reported'
  }

  function trafficLabel(peer: SyncPeerRow): string {
    if (peer.sendingBlocks === true) return 'sending block bodies'
    if (peer.blockRequested) return 'block bodies requested, none received yet'
    if (peer.sendingBlocks === null) return 'block traffic not reported'
    return 'no block bodies'
  }

  function directionLabel(peer: SyncPeerRow): string {
    if (peer.direction === 'incoming') return 'Incoming'
    if (peer.direction === 'outgoing') return 'Outgoing'
    return 'direction not reported'
  }
</script>

<div class="details" id="sync-details">
  {#if !details}
    <p>The node has not reported sync yet.</p>
  {:else}
    <dl>
      <div>
        <dt>Headers</dt>
        <dd class="num">{fmtInt(details.headersHeight)}</dd>
      </div>
      <div>
        <dt>Full blocks</dt>
        <dd class="num">{fmtInt(details.fullHeight)}</dd>
      </div>
      <div>
        <dt>Still to download</dt>
        <dd class="num">{details.blocksRemaining === null ? '—' : `${fmtInt(details.blocksRemaining)} blocks`}</dd>
      </div>
    </dl>

    {#if view?.stage === 'blocks' && ui.syncEta !== null}
      <p>{fmtEta(ui.syncEta)}</p>
    {:else if view?.stage === 'blocks'}
      <p>Time left is still being estimated.</p>
    {/if}
    {#if details.etaIsNodeSync}
      <p>That time is this node's own sync, not from the LAN.</p>
    {/if}
    {#if details.lanNote}
      <p>{details.lanNote}</p>
    {/if}
    {#if !details.peersKnown}
      <p>Connected peers could not be read from the node.</p>
    {:else if details.peers.length === 0}
      <p>No connected peers reported.</p>
    {:else}
      <ul>
        {#each details.peers as peer (peer.address)}
          <li>
            <span class="mono addr">{peer.address}</span>
            <span>{peer.lan ? 'On this LAN' : 'Not on this LAN'}</span>
            <span>{directionLabel(peer)}</span>
            <span>height {fmtInt(peer.remoteHeight)}</span>
            <span>{historyLabel(peer)}</span>
            <span>{trafficLabel(peer)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .details {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well);
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .details p {
    margin: 0;
  }

  dl {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
  }

  dl div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  dt {
    color: var(--dim);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  dd {
    margin: 0;
    color: var(--text-head);
    font-size: 13px;
    font-weight: 600;
    text-align: right;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .addr {
    color: var(--text-head);
    font-size: 12px;
  }
</style>
