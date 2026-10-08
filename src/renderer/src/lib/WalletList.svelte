<script lang="ts">
  import { onMount } from 'svelte'
  import { addressOnWalletRow } from '@shared/walletAddress'
  import { createReplacesWallet, showCreateWalletPrompt } from '@shared/walletPrompt'
  import { shortAddress } from './format'
  import { errorText, refreshWalletFiles, ui } from './store.svelte'

  let busy = $state(false)
  let error = $state<string | null>(null)
  let message = $state<string | null>(null)
  let confirmRemove = $state<string | null>(null)
  let confirmUse = $state<string | null>(null)

  const nodeAddress = $derived(ui.wallet.network === ui.network ? ui.wallet.address : null)
  const hasWallet = $derived(
    ui.walletFiles.some((w) => w.role === 'active') || createReplacesWallet(ui.wallet.phase)
  )

  onMount(() => {
    void refreshWalletFiles()
  })

  async function add(): Promise<void> {
    const keepAside = hasWallet
    busy = true
    error = null
    message = null
    try {
      const picked = await window.lithos.pickKeystore()
      if (!picked) return
      if (keepAside) {
        await window.lithos.addWallet(ui.network)
        await refreshWalletFiles()
        message = 'Added. The current wallet stays active. This one is kept on disk until you choose Use.'
      } else {
        ui.pendingKeystore = picked
        ui.wizard = 'keystore'
      }
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }

  async function remove(file: string): Promise<void> {
    busy = true
    error = null
    message = null
    try {
      await window.lithos.removeWallet(ui.network, file)
      confirmRemove = null
      await refreshWalletFiles()
      message = 'Moved aside. The wallet file is still on disk in removed-keystore and was not deleted.'
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }

  async function use(file: string): Promise<void> {
    busy = true
    error = null
    message = null
    try {
      await window.lithos.useWallet(ui.network, file)
      confirmUse = null
      await refreshWalletFiles()
      message = 'This wallet is now the active one. The previous wallet is kept on disk. Unlock it with its own password.'
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="list">
  <p class="note">
    One wallet is active for mining. Others stay on disk in previous-keystore. Remove moves a wallet file aside and does
    not delete it.
  </p>
  {#if ui.walletFiles.length === 0}
    <p class="note">No wallet files for this node yet.</p>
  {:else}
    <ul class="wallets">
      {#each ui.walletFiles as w (`${w.role}:${w.file}`)}
        {@const shown = addressOnWalletRow(w, ui.walletFiles, nodeAddress)}
        <li>
          <div class="item" class:loaded={w.role === 'active'}>
            <div class="item-body">
              <span class="micro">{w.role === 'active' ? 'Loaded in node' : 'Kept on disk'}</span>
              <span class="item-name" title={shown ?? ''}>{shown ? shortAddress(shown) : w.label}</span>
              <span class="hint">{new Date(w.savedAt).toLocaleDateString()}</span>
            </div>
            <div class="row">
              {#if w.role === 'kept'}
                <button class="btn small" type="button" onclick={() => (confirmUse = w.file)} disabled={busy}>Use</button>
              {/if}
              <button class="btn small" type="button" onclick={() => (confirmRemove = w.file)} disabled={busy}>Remove</button>
            </div>
          </div>
        {#if confirmUse === w.file}
          <form
            class="warn-note confirm"
            onsubmit={(event) => {
              event.preventDefault()
              void use(w.file)
            }}
          >
            <span>
              The current wallet will be set aside and kept on disk. Mining will use this wallet after the node
              restarts.
            </span>
            <div class="row">
              <button class="btn small" type="submit" disabled={busy}>Use this wallet</button>
              <button class="btn small" type="button" onclick={() => (confirmUse = null)} disabled={busy}>Cancel</button>
            </div>
          </form>
        {/if}
        {#if confirmRemove === w.file}
          <form
            class="warn-note confirm"
            onsubmit={(event) => {
              event.preventDefault()
              void remove(w.file)
            }}
          >
            <span>
              This moves the wallet file aside and keeps it on disk. It is not deleted.
              {#if w.role === 'active'}
                Mining stops using it after the node restarts.
              {/if}
            </span>
            <div class="row">
              <button class="btn small danger" type="submit" disabled={busy}>Move aside</button>
              <button class="btn small" type="button" onclick={() => (confirmRemove = null)} disabled={busy}>Cancel</button>
            </div>
          </form>
        {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if message}<p class="ok-note" role="status">{message}</p>{/if}
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}
  <div class="actions">
    {#if showCreateWalletPrompt(ui.wallet.phase)}
      <button class="btn primary" type="button" onclick={() => (ui.wizard = 'create')} disabled={busy}>
        Create a new wallet
      </button>
    {/if}
    <button class="btn" type="button" onclick={add} disabled={busy}>Add wallet</button>
    <button class="btn" type="button" onclick={() => (ui.wizard = 'restore')} disabled={busy}>Restore seed phrase</button>
  </div>
</div>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .wallets {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .wallets li {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 10px 10px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well);
  }

  .item.loaded {
    border-color: rgba(125, 211, 252, 0.45);
  }

  .item-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .item-name {
    overflow: hidden;
    color: var(--text-head);
    font-size: 12.5px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    color: var(--dim);
    font-size: 11.5px;
  }

  .row {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
  }

  .confirm {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .actions .btn {
    width: 100%;
  }
</style>
