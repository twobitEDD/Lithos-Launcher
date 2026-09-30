<script lang="ts">
  import { addressForNetwork } from '@shared/address'
  import { bondErg, parseConfigDiff } from '@shared/mining'
  import QRCode from 'qrcode'
  import { fmtErg, fmtInt, fmtPct, shortAddress } from './format'
  import Modal from './Modal.svelte'
  import ProgressBar from './ProgressBar.svelte'
  import { copyText, ui, unlockWallet } from './store.svelte'

  let password = $state('')
  let remember = $state(true)
  let error = $state<string | null>(null)
  let copied = $state(false)
  let showQr = $state(false)
  let qrDataUrl = $state<string | null>(null)
  let qrError = $state<string | null>(null)

  const w = $derived(ui.wallet)
  const secure = $derived(ui.vault?.secure ?? false)
  const diffValue = $derived(parseConfigDiff(ui.clientSettings?.diff))
  const bond = $derived(diffValue ? bondErg(diffValue) : null)
  // Ignore a wallet snapshot that still belongs to the other network.
  const onNetwork = $derived(w.network === ui.network)
  const phase = $derived(onNetwork || w.network === null ? w.phase : 'unavailable')
  const address = $derived(w.address ? addressForNetwork(w.address, ui.network) : null)
  const balanceNanoErg = $derived(onNetwork ? w.balanceNanoErg : null)
  const walletHeight = $derived(onNetwork ? w.walletHeight : null)
  // A restored or imported wallet scans the whole chain for its history; show how far it has got.
  const chainHeight = $derived(
    ui.node.status === 'running' && ui.node.network === ui.network ? (ui.info?.fullHeight ?? null) : null
  )
  const scanning = $derived(
    phase === 'unlocked' && walletHeight !== null && chainHeight !== null && walletHeight < chainHeight - 3
  )
  const balance = $derived(balanceNanoErg === null ? null : fmtErg(balanceNanoErg).split('.'))

  async function unlock(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = await unlockWallet(password, remember)
    if (!error) password = ''
  }

  /** The side column can scroll; make sure a new error is actually on screen. */
  function reveal(node: HTMLElement): void {
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  async function copy(): Promise<void> {
    if (!address) return
    await copyText(address)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  async function openQr(): Promise<void> {
    if (!address) return
    qrError = null
    qrDataUrl = null
    showQr = true
    try {
      qrDataUrl = await QRCode.toDataURL(address, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 280,
        color: { dark: '#0b1020', light: '#ffffff' }
      })
    } catch (err) {
      qrError = err instanceof Error ? err.message : String(err)
    }
  }

  function closeQr(): void {
    showQr = false
    qrDataUrl = null
    qrError = null
  }
</script>

<section class="panel" aria-labelledby="wallet-title">
  <div class="panel-head">
    <h2 class="card-title" id="wallet-title">
      <span class="swatch you" aria-hidden="true"></span>Wallet<span class="no">03</span>
    </h2>
    {#if phase === 'unlocked'}
      <span class="badge micro ok"><span class="dot" aria-hidden="true"></span>Unlocked</span>
    {:else if phase === 'locked' || phase === 'unlocking'}
      <span class="badge micro warn"><span class="dot" aria-hidden="true"></span>Locked</span>
    {/if}
  </div>

  <div class="body">
    {#if phase === 'unavailable' && !address}
      <p class="note">Start the node to create or unlock the wallet Lithos mines with.</p>
    {:else if phase === 'unavailable'}
      {@render balanceRow()}
      {@render addressRow()}
      <p class="note">
        This is the same key on {ui.network}. Mainnet addresses start with 9 and testnet addresses start with 3.
        {#if ui.node.status === 'running' && ui.node.network === ui.network}
          Reading the balance…
        {:else}
          Start the {ui.network} node to read the balance.
        {/if}
      </p>
    {:else if phase === 'uninitialized'}
      {@const sameKey = Boolean(address) || w.hasPeerWallet}
      <p class="note">
        {#if sameKey}
          This node has no wallet yet. Restore the same seed phrase you already use, or the keystore from your other
          network. The key stays the same on {ui.network}.
        {:else}
          This node has no wallet yet. The Lithos Client signs its mining transactions with it, so use a wallet made
          just for mining.
        {/if}
      </p>
      {#if address}{@render addressRow()}{/if}
      {#if !sameKey}
        <button class="btn primary" onclick={() => (ui.wizard = 'create')}>Create a new wallet</button>
      {/if}
      <div class="actions">
        <button class="btn" class:primary={sameKey} onclick={() => (ui.wizard = 'restore')}>
          {sameKey ? 'Restore the same seed phrase' : 'Restore seed phrase'}
        </button>
        <button class="btn" onclick={() => (ui.wizard = 'keystore')}>Use keystore file</button>
      </div>
    {:else if phase === 'unlocking'}
      <p class="note">Unlocking the wallet…</p>
      <ProgressBar value={null} label="Unlocking wallet" />
    {:else if phase === 'locked'}
      {#if address}{@render addressRow()}{/if}
      <form class="unlock" onsubmit={unlock}>
        <div class="field">
          <label class="micro" for="wallet-password">Wallet password</label>
          <input
            id="wallet-password"
            class="input"
            type="password"
            autocomplete="current-password"
            bind:value={password}
          />
        </div>
        {#if secure}
          <label class="check"><input type="checkbox" bind:checked={remember} /> Remember on this computer</label>
        {:else}
          <p class="note">No system keyring found, so the password is kept only until the launcher closes.</p>
        {/if}
        {#if error ?? w.error}
          {#key error ?? w.error}
            <p class="error-text" role="alert" use:reveal>{error ?? w.error}</p>
          {/key}
        {/if}
        <button class="btn primary" type="submit" disabled={!password}>Unlock wallet</button>
      </form>
    {:else}
      {@render balanceRow()}
      {@render addressRow()}
      {#if scanning && walletHeight !== null && chainHeight !== null}
        <div class="scan">
          <div class="scan-head">
            <span class="micro">Scanning history</span>
            <span class="num">{fmtPct(walletHeight / chainHeight)}</span>
          </div>
          <ProgressBar value={walletHeight / chainHeight} label="Wallet scan" tone="you" />
          <span class="sub">
            Block <span class="num">{fmtInt(walletHeight)}</span> of <span class="num">{fmtInt(chainHeight)}</span>.
            The balance fills in as it goes.
          </span>
        </div>
      {/if}
      {#if balanceNanoErg === 0 && !scanning}
        <p class="warn-note">
          Send some ERG to this address. Each proof you submit posts a small refundable bond{bond
            ? ` (${bond.toFixed(4)} ERG at your difficulty)`
            : ''} plus a fee.
        </p>
      {/if}
      <p class="note">
        {#if w.passwordKnown && secure}
          Unlocks automatically whenever the node starts.
        {:else if w.passwordKnown}
          Unlocks automatically until the launcher closes.
        {:else}
          You'll be asked for the password next time the node starts.
        {/if}
      </p>
    {/if}
  </div>
</section>

{#if showQr && address}
  <Modal labelledby="wallet-qr-title" onclose={closeQr} width={420}>
    <div class="content">
      <div class="top">
        <span class="micro">Wallet · Receive</span>
        <button class="x" aria-label="Close" onclick={closeQr}>✕</button>
      </div>
      <h2 id="wallet-qr-title">Scan to send ERG</h2>
      <p class="note">Point a wallet camera at this code to fund the mining address.</p>
      <div class="qr-frame">
        {#if qrError}
          <p class="error-text" role="alert">{qrError}</p>
        {:else if qrDataUrl}
          <img class="qr" src={qrDataUrl} alt="QR code for mining wallet address" width="280" height="280" />
        {:else}
          <p class="note">Generating QR…</p>
        {/if}
      </div>
      <code class="mono full-addr">{address}</code>
      <div class="footer">
        <button class="btn small" onclick={copy}>{copied ? 'Copied' : 'Copy address'}</button>
        <button class="btn primary" onclick={closeQr}>Done</button>
      </div>
    </div>
  </Modal>
{/if}

{#snippet balanceRow()}
  <div class="balance">
    <span class="micro">Balance</span>
    <span class="big num" class:zero={balanceNanoErg === 0}>
      {#if balance}{balance[0]}{#if balance[1]}<span class="dec">.{balance[1]}</span>{/if}{:else}—{/if}<span class="unit"
        >ERG</span
      >
    </span>
  </div>
{/snippet}

{#snippet addressRow()}
  <div class="address well">
    <span class="micro">Address</span>
    <code class="mono" title={address ?? ''}>{address ? shortAddress(address) : '—'}</code>
    <div class="addr-actions">
      <button class="btn small" onclick={openQr} disabled={!address} aria-expanded={showQr}>QR</button>
      <button class="btn small" onclick={copy} disabled={!address}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  </div>
{/snippet}

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 20px 20px;
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .unlock {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .badge {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }

  .ok {
    color: var(--mint);
  }

  .ok .dot {
    background: var(--mint);
    box-shadow: 0 0 8px rgba(110, 231, 183, 0.5);
  }

  .warn {
    color: var(--amber-light);
  }

  .warn .dot {
    background: var(--amber);
  }

  .balance {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  /* The Mining page's big stat: heavy tabular figures, unit in the "you" colour. */
  .big {
    color: var(--text-head);
    font-size: 30px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
  }

  .big.zero {
    color: var(--amber-light);
  }

  .dec {
    color: var(--muted);
    font-size: 0.62em;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .unit {
    margin-left: 5px;
    color: var(--amber-light);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.07em;
  }

  .address {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
  }

  .addr-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  code {
    overflow: hidden;
    color: var(--text-head);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scan {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .scan-head {
    display: flex;
    justify-content: space-between;
    color: var(--amber-light);
    font-size: 12px;
    font-weight: 600;
  }

  .sub {
    color: var(--faint);
    font-size: 11px;
  }

  .sub .num {
    color: var(--muted);
  }

  .qr-frame {
    display: grid;
    place-items: center;
    min-height: 280px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #fff;
  }

  .qr {
    display: block;
    width: 280px;
    height: 280px;
  }

  .full-addr {
    display: block;
    padding: 10px 12px;
    overflow-wrap: anywhere;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well);
    color: var(--text-head);
    font-size: 12px;
    line-height: 1.45;
    white-space: normal;
  }
</style>
