<script lang="ts">
  import { fmtConfigDiff, recommendedBalanceNanoErg } from '@shared/mining'
  import { addressForSelection } from '@shared/walletAddress'
  import { cycleActiveWallet } from '@shared/walletCycle'
  import QRCode from 'qrcode'
  import { fmtErg, fmtInt, fmtPct, shortAddress } from './format'
  import Modal from './Modal.svelte'
  import ProgressBar from './ProgressBar.svelte'
  import { copyText, errorText, miningBalanceTarget, refreshWalletFiles, ui, unlockWallet, walletScan } from './store.svelte'
  import WalletList from './WalletList.svelte'

  let password = $state('')
  let remember = $state(true)
  let error = $state<string | null>(null)
  let copied = $state<'card' | 'dialog' | null>(null)
  let showQr = $state(false)
  let qrDataUrl = $state<string | null>(null)
  let qrError = $state<string | null>(null)
  /** Wallet management (create, add, remove, switch) stays tucked away until asked for. */
  let manageOpen = $state(false)
  let switching = $state(false)
  let switchError = $state<string | null>(null)

  const w = $derived(ui.wallet)
  const activeWallet = $derived(ui.walletFiles.find((file) => file.role === 'active') ?? null)
  const secure = $derived(ui.vault?.secure ?? false)
  // Ignore a wallet snapshot that still belongs to the other network.
  const onNetwork = $derived(w.network === ui.network)
  const phase = $derived(onNetwork || w.network === null ? w.phase : 'unavailable')
  // The node's changeAddress is the one loaded keystore. The selected wallet shows its own record.
  const nodeAddress = $derived(onNetwork ? w.address : null)
  const address = $derived(addressForSelection(ui.walletFiles, activeWallet?.file ?? null, nodeAddress))
  const loadedMatches = $derived(!address || !nodeAddress || address === nodeAddress)
  const other = $derived(ui.network === 'mainnet' ? 'testnet' : 'mainnet')
  const balanceNanoErg = $derived(onNetwork && loadedMatches ? w.balanceNanoErg : null)
  const sameKey = $derived(ui.shareWalletAcrossNetworks && (Boolean(nodeAddress) || w.hasPeerWallet))
  // A restored or imported wallet scans the whole chain for its history; show how far it has got.
  const scan = $derived(onNetwork && loadedMatches ? walletScan() : null)
  const balance = $derived(balanceNanoErg === null ? null : fmtErg(balanceNanoErg).split('.'))
  const target = $derived(miningBalanceTarget())
  // Name the difficulty only when it's what pushed the target above the floor.
  const scaled = $derived(target.nanoErg > recommendedBalanceNanoErg(null) && target.diff !== null)
  const low = $derived(balanceNanoErg !== null && balanceNanoErg < target.nanoErg)

  async function unlock(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = await unlockWallet(password, remember)
    if (!error) password = ''
  }

  /** The side column can scroll; make sure a new error is actually on screen. */
  function reveal(node: HTMLElement): void {
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  /** `from` is the button that was clicked, so only that one says "Copied". */
  async function copy(from: 'card' | 'dialog'): Promise<void> {
    if (!address) return
    await copyText(address)
    copied = from
    setTimeout(() => (copied = null), 1500)
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

  /** Previous/next loads that keystore. It does not only move a highlight. */
  async function cycle(direction: 1 | -1): Promise<void> {
    const next = cycleActiveWallet(ui.walletFiles, direction)
    if (!next || next.activeFile === activeWallet?.file) return
    switching = true
    switchError = null
    try {
      await window.lithos.useWallet(ui.network, next.activeFile)
      await refreshWalletFiles()
    } catch (err) {
      switchError = errorText(err)
    } finally {
      switching = false
    }
  }
</script>

<section class="panel" aria-labelledby="wallet-title">
  <div class="panel-head">
    <h2 class="card-title" id="wallet-title">
      <span class="swatch you" aria-hidden="true"></span>Wallet<span class="no">03</span>
    </h2>
    <div class="head-actions">
      {#if phase === 'unlocked'}
        <span class="badge micro ok"><span class="dot" aria-hidden="true"></span>Unlocked</span>
      {:else if phase === 'locked' || phase === 'unlocking'}
        <span class="badge micro warn"><span class="dot" aria-hidden="true"></span>Locked</span>
      {/if}
      <button
        class="btn small gear"
        class:on={manageOpen}
        type="button"
        aria-expanded={manageOpen}
        aria-controls="wallet-manage"
        aria-label="Wallet settings"
        title="Wallet settings"
        onclick={() => (manageOpen = !manageOpen)}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
        </svg>
      </button>
    </div>
  </div>

  <div class="body">
    {#if ui.walletFiles.length > 1}
      <div class="cycle">
        <button class="btn small" type="button" aria-label="Previous wallet" onclick={() => cycle(-1)} disabled={switching}>
          Previous
        </button>
        <span class="cycle-name">
          <span class="micro">Active wallet</span>
          <span class="item-name">{address ? shortAddress(address) : (activeWallet?.label ?? 'None loaded')}</span>
        </span>
        <button class="btn small" type="button" aria-label="Next wallet" onclick={() => cycle(1)} disabled={switching}>
          Next
        </button>
      </div>
      {#if switching}<p class="note">Switching the active wallet. The node reloads that keystore.</p>{/if}
      {#if switchError}<p class="error-text" role="alert">{switchError}</p>{/if}
    {/if}
    {#if phase === 'unavailable' && !address}
      <p class="note" id="create-wallet-prompt">Start the node to create or unlock the wallet Lithos mines with.</p>
    {:else if phase === 'unavailable'}
      {@render balanceRow()}
      {@render addressRow()}
      <p class="note">
        {#if w.addressFromPeer}
          Your {other} wallet's key as a {ui.network} address. Mainnet addresses start with 9 and testnet addresses
          start with 3. Start the {ui.network} node to use it here.
        {:else}
          {#if w.keyMatch === 'same'}
            The same key as your {other} wallet. Mainnet addresses start with 9 and testnet addresses start with 3.
          {:else}
            Mining wallet for {ui.network}.
          {/if}
          {#if ui.node.status === 'running' && ui.node.network === ui.network}
            Reading the balance…
          {:else}
            Start the {ui.network} node to read the balance.
          {/if}
        {/if}
      </p>
    {:else if phase === 'uninitialized'}
      <p class="note" id="create-wallet-prompt">
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
      {#if address || ui.walletFiles.length > 0}{@render addressRow()}{/if}
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
      {#if scan}
        <div class="scan">
          <div class="scan-head">
            <span class="micro">Scanning history</span>
            <span class="num">{fmtPct(scan.height / scan.tip)}</span>
          </div>
          <ProgressBar value={scan.height / scan.tip} label="Wallet scan" tone="you" />
          <span class="sub">
            Block <span class="num">{fmtInt(scan.height)}</span> of <span class="num">{fmtInt(scan.tip)}</span>. The
            balance fills in as it goes.
          </span>
        </div>
      {/if}
      {#if low && !scan}
        <p class="warn-note">
          {#if scaled}At your difficulty of <b>{fmtConfigDiff(target.diff!)}</b>, we{:else}We{/if} recommend at least
          <b>{fmtErg(target.nanoErg)} ERG</b> in this wallet to commit your difficulty and submit proofs. Send some to the
          address above. You can send more if you also want to use the DEX and
          collateral market.
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
    {#if onNetwork && w.keyMatch === 'different'}
      <p class="warn-note">
        Sharing is on, but your mainnet and testnet wallets already use different keys, so each network keeps its own.
        Make sure you fund the {ui.network} address shown here.
      </p>
    {/if}
    {#if manageOpen}
      <div class="manage" id="wallet-manage">
        <WalletList />
      </div>
    {/if}
  </div>
</section>

{#snippet balanceRow()}
  <div class="balance">
    <span class="micro">Balance</span>
    <span class="big num" class:low>
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
      <button class="btn small" onclick={openQr} disabled={!address} aria-haspopup="dialog">QR</button>
      <button class="btn small" onclick={() => copy('card')} disabled={!address}>
        {copied === 'card' ? 'Copied' : 'Copy'}
      </button>
    </div>
  </div>
{/snippet}

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
        <button class="btn small" onclick={() => copy('dialog')}>{copied === 'dialog' ? 'Copied' : 'Copy address'}</button>
        <button class="btn primary" onclick={closeQr}>Done</button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .head-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .gear {
    padding: 5px 7px;
  }

  .gear svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  .gear.on {
    border-color: rgba(125, 211, 252, 0.45);
    color: var(--sky-light);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 20px 20px;
  }

  .cycle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .cycle-name {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    text-align: center;
  }

  .cycle-name .item-name {
    overflow: hidden;
    color: var(--text-head);
    font-size: 12.5px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .manage {
    padding-top: 12px;
    border-top: 1px solid var(--border);
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

  .big.low {
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
    padding: 8px 8px 8px 12px;
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
