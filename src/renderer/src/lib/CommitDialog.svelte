<script lang="ts">
  import { COMMIT_BINDS_BLOCKS, COMMIT_REPLACE_BLOCKS, blocksAsTime, bondErg, parseConfigDiff } from '@shared/mining'
  import { fmtErg } from './format'
  import Modal from './Modal.svelte'
  import { restartClient, saveClientSettings, ui } from './store.svelte'

  const network = ui.network
  let understood = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)

  const settings = $derived(ui.clientSettings)
  const diff = $derived(settings?.diff ?? null)
  const bond = $derived(diff ? bondErg(parseConfigDiff(diff) ?? 0) : null)
  const balance = $derived(ui.wallet.network === network ? ui.wallet.balanceNanoErg : null)
  const clientRunning = $derived(ui.client.status === 'running' && ui.client.network === network)

  function close(): void {
    if (!busy) ui.dialog = null
  }

  async function setAutoCommit(on: boolean): Promise<void> {
    busy = true
    error = await saveClientSettings({ autoCommit: on })
    if (!error && clientRunning) await restartClient()
    busy = false
    if (!error) ui.dialog = null
  }
</script>

<Modal labelledby="commit-title" onclose={close} width={620}>
  <div class="content">
    <div class="top">
      <span class="micro">Mining · {network}</span>
      <button class="x" aria-label="Close" onclick={close} disabled={busy}>✕</button>
    </div>
    <h2 id="commit-title">Commit your difficulty on chain</h2>

    {#if !diff}
      <p class="note">Choose a difficulty first. The commitment is a promise to mine at it.</p>
      <div class="footer">
        <button class="btn" onclick={close}>Close</button>
        <button class="btn primary" onclick={() => (ui.dialog = 'difficulty')}>Choose difficulty</button>
      </div>
    {:else}
      <p class="note">
        Lithos only pays miners who are registered on chain with a committed difficulty. Until you commit, the client
        mines normally but can't submit proofs, so you are not paid. When you turn on auto-commit, the client registers
        you and commits <b class="mono">{diff}</b> for you.
      </p>

      <ul class="facts">
        <li>
          <span class="micro">Takes effect</span>
          <span>{COMMIT_BINDS_BLOCKS} blocks after it's sent, {blocksAsTime(COMMIT_BINDS_BLOCKS, network)}.</span>
        </li>
        <li>
          <span class="micro">Locked for</span>
          <span>
            {COMMIT_REPLACE_BLOCKS} blocks, {blocksAsTime(COMMIT_REPLACE_BLOCKS, network)}. You can't change it sooner, so
            pick a difficulty you can leave alone.
          </span>
        </li>
        <li>
          <span class="micro">Costs</span>
          <span>
            Each proof posts a refundable bond of <b class="mono">{bond?.toFixed(4)} ERG</b> plus about 0.001 ERG in fees,
            from this node's wallet. Proofs can overlap, so keep enough for several.
          </span>
        </li>
        <li>
          <span class="micro">First sync</span>
          <span>The client syncs the miner registry before it can register (about 30 minutes on testnet).</span>
        </li>
      </ul>

      <div class="balance" class:empty={balance === 0}>
        <span class="micro">Wallet balance</span>
        <span class="mono">{balance === null ? 'unknown (unlock the wallet)' : `${fmtErg(balance)} ERG`}</span>
        {#if balance === 0}<span class="warn">Fund the wallet first, or proofs will fail to build.</span>{/if}
      </div>

      {#if settings?.autoCommit}
        <p class="note">
          Auto-commit is <b>on</b>. The client keeps your commitment equal to <b class="mono">{diff}</b>, sending changes
          when the contracts allow. Turning it off stops future commitments; anything already sent stays on chain.
        </p>
        {#if error}<p class="error-text" role="alert">{error}</p>{/if}
        <div class="footer">
          <button class="btn" onclick={close} disabled={busy}>Close</button>
          <button class="btn danger" onclick={() => setAutoCommit(false)} disabled={busy}>
            {busy ? 'Saving…' : 'Turn off auto-commit'}
          </button>
        </div>
      {:else}
        <label class="check">
          <input type="checkbox" bind:checked={understood} />
          I understand {diff} will be locked for {blocksAsTime(COMMIT_REPLACE_BLOCKS, network)} once committed
        </label>
        {#if error}<p class="error-text" role="alert">{error}</p>{/if}
        <div class="footer">
          <button class="btn" onclick={close} disabled={busy}>Not yet</button>
          <button class="btn primary" onclick={() => setAutoCommit(true)} disabled={busy || !understood}>
            {busy ? 'Saving…' : clientRunning ? 'Turn on and restart client' : 'Turn on auto-commit'}
          </button>
        </div>
      {/if}
    {/if}
  </div>
</Modal>

<style>
  .balance {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 14px;
    color: var(--text-head);
  }

  .balance .warn {
    flex-basis: 100%;
    color: var(--amber-light);
    font-size: 12px;
  }
</style>
