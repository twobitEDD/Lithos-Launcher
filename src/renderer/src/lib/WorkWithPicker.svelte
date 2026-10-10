<script lang="ts">
  import {
    DEFAULT_WORK_WITH,
    LAN_NODE_FOR_CLIENT_NOTE,
    lanLauncherSummary,
    rewardsText,
    type WorkWith,
    type WorkWithScope
  } from '@shared/workWith'
  import { rescanLanLaunchers, setMinerWorkWith, ui } from './store.svelte'

  // The "Work with" picker: which Lithos stratum this computer's SOAT miner uses. The SOAT service
  // keeps the choice, so the miner card, Settings and the SOAT Miner window all show the same one.
  let { canRescan = false, idPrefix = 'ww' }: { canRescan?: boolean; idPrefix?: string } = $props()

  const m = $derived(ui.miner)
  const choice = $derived<WorkWith>(m.workWith ?? DEFAULT_WORK_WITH)
  const launchers = $derived(m.lanLaunchers ?? [])
  const value = $derived(choice.mode === 'lan' ? `lan:${choice.host}` : choice.mode)
  const picked = $derived(choice.mode === 'lan' ? (launchers.find((l) => l.host === choice.host) ?? null) : null)
  const serviceKnows = $derived(m.workWith !== undefined)
  let busy = $state(false)
  let scanning = $state(false)

  async function apply(next: WorkWith): Promise<void> {
    busy = true
    try {
      await setMinerWorkWith(next)
    } finally {
      busy = false
    }
  }

  function pick(v: string): void {
    if (v === 'auto' || v === 'local') void apply({ mode: v, host: null, scope: choice.scope })
    else if (v.startsWith('lan:')) void apply({ mode: 'lan', host: v.slice(4), scope: choice.scope })
  }

  function setScope(scope: WorkWithScope): void {
    if (choice.mode === 'lan') void apply({ ...choice, scope })
  }

  async function rescan(): Promise<void> {
    scanning = true
    try {
      await rescanLanLaunchers()
    } finally {
      scanning = false
    }
  }
</script>

<div class="work-with">
  <div class="head">
    <label class="micro" for="{idPrefix}-select">Work with</label>
    <select
      id="{idPrefix}-select"
      class="input"
      {value}
      disabled={busy}
      onchange={(e) => pick(e.currentTarget.value)}
      title="Which Lithos Client's stratum the SOAT miner on this computer mines into"
    >
      <option value="auto">Automatic (this computer when ready, otherwise the best LAN launcher)</option>
      <option value="local">This computer only</option>
      {#each launchers as l (l.host)}
        <option value="lan:{l.host}" disabled={l.skip !== null && choice.host !== l.host}>
          {l.host}{l.stratumPort ? `:${l.stratumPort}` : ''} — {lanLauncherSummary(l)}{l.skip ? ` (${l.skip})` : ''}
        </option>
      {/each}
      {#if choice.mode === 'lan' && !picked}
        <option value="lan:{choice.host}">{choice.host} (not found on the LAN right now)</option>
      {/if}
    </select>
    {#if canRescan}
      <button class="btn small" type="button" onclick={() => void rescan()} disabled={scanning}>
        {scanning ? 'Looking…' : 'Rescan LAN'}
      </button>
    {/if}
  </div>

  {#if choice.mode === 'lan'}
    <div class="scope" role="radiogroup" aria-label="How long to work with {choice.host}">
      <label>
        <input
          type="radio"
          name="{idPrefix}-scope"
          checked={choice.scope === 'syncing'}
          disabled={busy}
          onchange={() => setScope('syncing')}
        />
        Only while this computer's node or wallet is syncing (moves back here by itself once this computer's Lithos Client
        has a current job and the wallet has scanned)
      </label>
      <label>
        <input
          type="radio"
          name="{idPrefix}-scope"
          checked={choice.scope === 'always'}
          disabled={busy}
          onchange={() => setScope('always')}
        />
        Always
      </label>
    </div>
    {#if picked}
      <p class="micro facts">{picked.host}: {lanLauncherSummary(picked)}{picked.skip ? ` — can't use it now: ${picked.skip}` : ''}</p>
    {/if}
  {:else if launchers.length === 0}
    <p class="micro facts">
      No other Lithos launcher found on the LAN yet{canRescan ? '' : ' (Lithos Launcher looks every 10 to 30 minutes)'}.
    </p>
  {/if}

  {#if serviceKnows}
    <p class="rewards" class:remote={m.via}>{rewardsText(m.via ?? null)}</p>
  {:else if m.service?.reachable}
    <p class="micro facts">
      The SOAT service running now is older than this window; it uses this choice after it restarts.
    </p>
  {/if}
  {#if m.workNote}<p class="micro note">{m.workNote}</p>{/if}
  {#if m.walletWaiting}<p class="micro note" role="status">{m.walletWaiting}</p>{/if}
  <p class="micro why" title={LAN_NODE_FOR_CLIENT_NOTE}>
    Why not run this computer's own Lithos Client on another computer's node? <span class="info" aria-hidden="true">ⓘ</span>
    <span class="sr-only">{LAN_NODE_FOR_CLIENT_NOTE}</span>
  </p>
</div>

<style>
  .work-with {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
    font-size: 12px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .head select {
    flex: 1;
    min-width: 0;
  }

  .scope {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .scope label {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--muted, #8b93a7);
  }

  .work-with p {
    margin: 0;
  }

  .facts,
  .why {
    color: var(--muted, #8b93a7);
  }

  .rewards.remote {
    color: #f0b429;
  }

  .note {
    color: var(--text, #e8eaef);
  }

  .why {
    cursor: help;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
