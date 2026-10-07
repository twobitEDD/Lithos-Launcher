<script lang="ts">
  import { onDestroy } from 'svelte'
  import { MNEMONIC_LENGTHS, type KeystorePick } from '@shared/types'
  import {
    canSubmitCreateWallet,
    createReplacesWallet,
    createWalletNodeProblem,
    createWalletPasswordProblem,
    existingWalletCreateNote,
    replaceWalletBlocked
  } from '@shared/walletPrompt'
  import { errorText, ui } from './store.svelte'

  type Step = 'password' | 'seed' | 'confirm' | 'restore' | 'keystore' | 'done'

  const mode = ui.wizard ?? 'create'
  let step = $state<Step>(mode === 'restore' ? 'restore' : mode === 'keystore' ? 'keystore' : 'password')
  let keystore = $state<KeystorePick | null>(ui.pendingKeystore)
  let replaceConfirmed = $state(false)
  let replacedExisting = $state(false)
  let password = $state('')
  let confirmPassword = $state('')
  let showPassword = $state(false)
  let mnemonic = $state('')
  let words = $state<string[]>([])
  let wroteDown = $state(false)
  let checks = $state<{ index: number; value: string }[]>([])
  let busy = $state(false)
  let error = $state<string | null>(null)

  const secure = $derived(ui.vault?.secure ?? false)
  const nodeUp = $derived(ui.node.status === 'running')
  const nodeProblem = $derived(createWalletNodeProblem(nodeUp))
  const passwordProblem = $derived(createWalletPasswordProblem(password, confirmPassword))
  const createReady = $derived(canSubmitCreateWallet({ busy, password, confirmPassword }))
  const existingWalletNote = $derived(existingWalletCreateNote(ui.wallet.phase))
  const restoreWords = $derived(mnemonic.trim() ? mnemonic.trim().split(/\s+/).length : 0)
  const restoreCountOk = $derived((MNEMONIC_LENGTHS as readonly number[]).includes(restoreWords))

  // While the seed is on screen and unconfirmed: hide the window from screen capture (Windows only)
  // and block closing.
  const sensitive = $derived(step === 'seed' || step === 'confirm')
  $effect(() => {
    void window.lithos.setSensitive(sensitive)
    if (!sensitive) return
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  })
  onDestroy(() => void window.lithos.setSensitive(false))

  // Linux can't keep a window out of screenshots, so the words stay masked unless Reveal is held
  // or masking is turned off. Masked words are a fixed placeholder, never the real word blurred:
  // seed words come from a 2048-word list, so a blurred word could be matched from a screenshot.
  const linux = ui.platform === 'linux'
  const MASK = '••••••'
  let unmasked = $state(false)
  let holding = $state(false)
  const masked = $derived(linux && !unmasked && !holding)

  function holdKey(event: KeyboardEvent, on: boolean): void {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) holding = on
  }

  const passwordNote = $derived(
    secure
      ? 'The launcher saves this password, encrypted by your operating system, to unlock the wallet when the node starts.'
      : 'No system keyring was found, so the launcher keeps this password only until it closes.'
  )

  /** Moves focus into each step for keyboard and screen reader users. */
  function focusFirst(node: HTMLElement): void {
    requestAnimationFrame(() => node.querySelector<HTMLElement>('input, textarea, button')?.focus())
  }

  function close(): void {
    words = []
    checks = []
    ui.pendingKeystore = null
    ui.wizard = null
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !sensitive && !busy) close()
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (passwordProblem) return
    if (nodeProblem) {
      error = nodeProblem
      return
    }
    const blocked = replaceWalletBlocked(ui.wallet.phase, replaceConfirmed)
    if (blocked) {
      error = blocked
      return
    }
    const replaces = createReplacesWallet(ui.wallet.phase)
    busy = true
    error = null
    try {
      words = await window.lithos.createWallet(password, replaces)
      replacedExisting = replaces
      password = ''
      confirmPassword = ''
      step = 'seed'
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }

  function pickChecks(): void {
    const picked = new Set<number>()
    const buf = new Uint32Array(1)
    while (picked.size < Math.min(3, words.length)) {
      crypto.getRandomValues(buf)
      picked.add(buf[0] % words.length)
    }
    checks = [...picked].sort((a, b) => a - b).map((index) => ({ index, value: '' }))
    error = null
    step = 'confirm'
  }

  function verify(event: SubmitEvent): void {
    event.preventDefault()
    const wrong = checks.find((c) => c.value.trim().toLowerCase() !== words[c.index])
    if (wrong) {
      error = `Word #${wrong.index + 1} doesn't match. Check your paper copy.`
      return
    }
    words = []
    checks = []
    error = null
    step = 'done'
  }

  /** The main process opens the picker and keeps the path; only the file's name comes back. */
  async function chooseKeystore(): Promise<void> {
    error = null
    try {
      keystore = (await window.lithos.pickKeystore()) ?? keystore
    } catch (err) {
      error = errorText(err)
    }
  }

  async function useKeystore(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!keystore || !password) return
    busy = true
    error = null
    try {
      await window.lithos.importKeystore(password)
      password = ''
      step = 'done'
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }

  async function restore(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (passwordProblem || !restoreCountOk) return
    const blocked = replaceWalletBlocked(ui.wallet.phase, replaceConfirmed)
    if (blocked) {
      error = blocked
      return
    }
    const replaces = createReplacesWallet(ui.wallet.phase)
    busy = true
    error = null
    try {
      await window.lithos.restoreWallet(mnemonic, password, replaces)
      replacedExisting = replaces
      mnemonic = ''
      password = ''
      confirmPassword = ''
      step = 'done'
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }
</script>

<svelte:window onkeydown={onKeydown} onblur={() => (holding = false)} />

<div class="overlay">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
    <div class="scroll">
      {#if step === 'password'}
        <form class="content" onsubmit={create} use:focusFirst>
          <div class="top">
            <span class="micro">Create wallet · Step 1 of 3</span>
            <button type="button" class="x" aria-label="Close" onclick={close} disabled={busy}>✕</button>
          </div>
          <h2 id="wizard-title">Create a new wallet</h2>
          <p class="note">Choose a password. It encrypts the wallet file on this computer. {passwordNote}</p>
          {#if nodeProblem}
            <p class="note">{nodeProblem}</p>
          {/if}
          <div class="field">
            <label class="micro" for="new-password">Password</label>
            <input
              id="new-password"
              class="input"
              type={showPassword ? 'text' : 'password'}
              autocomplete="new-password"
              bind:value={password}
            />
          </div>
          <div class="field">
            <label class="micro" for="confirm-password">Repeat password</label>
            <input
              id="confirm-password"
              class="input"
              type={showPassword ? 'text' : 'password'}
              autocomplete="new-password"
              bind:value={confirmPassword}
            />
          </div>
          <label class="check"><input type="checkbox" bind:checked={showPassword} /> Show password</label>
          {#if password && passwordProblem}
            <p class="hint">{passwordProblem}</p>
          {/if}
          {#if existingWalletNote}
            <p class="warn-note" role="status">{existingWalletNote}</p>
            <label class="check">
              <input type="checkbox" bind:checked={replaceConfirmed} />
              Set aside the current wallet and create a new one
            </label>
          {/if}
          {#if error}<p class="error-text" role="alert">{error}</p>{/if}
          <button class="btn primary" type="submit" disabled={!createReady}>
            {busy ? 'Creating wallet…' : 'Create a new wallet'}
          </button>
        </form>
      {:else if step === 'seed'}
        <div class="content" use:focusFirst>
          <div class="top"><span class="micro">Create wallet · Step 2 of 3</span></div>
          <h2 id="wizard-title">Write down your seed phrase</h2>
          <ul class="warnings warn-note">
            <li>Write these {words.length} words on paper, in order.</li>
            <li>Anyone who has them can take the funds in this wallet. Never type them into a website.</li>
            <li>The launcher does not save them and cannot show them again.</li>
            {#if linux}
              <li>
                On Linux the launcher cannot keep this screen out of screenshots or screen recordings. Stop any screen
                sharing or recording before you show the words.
              </li>
            {/if}
            {#if replacedExisting}
              <li>The previous wallet was set aside and is still on disk in previous-keystore.</li>
            {/if}
          </ul>
          <ol class="words" class:masked aria-label="Seed phrase">
            {#each words as word, i (i)}
              <li><span class="n mono">{i + 1}</span><span class="w mono">{masked ? MASK : word}</span></li>
            {/each}
          </ol>
          {#if linux}
            <div class="reveal">
              <button
                type="button"
                class="btn small"
                disabled={unmasked}
                onpointerdown={() => (holding = true)}
                onpointerup={() => (holding = false)}
                onpointerleave={() => (holding = false)}
                onpointercancel={() => (holding = false)}
                onkeydown={(e) => holdKey(e, true)}
                onkeyup={(e) => holdKey(e, false)}
                onblur={() => (holding = false)}>Hold to show words</button
              >
              <label class="check"><input type="checkbox" bind:checked={unmasked} /> Show the words without masking</label>
            </div>
          {/if}
          <label class="check"><input type="checkbox" bind:checked={wroteDown} /> I wrote down all {words.length} words</label>
          <button class="btn primary" onclick={pickChecks} disabled={!wroteDown}>Continue</button>
        </div>
      {:else if step === 'confirm'}
        <form class="content" onsubmit={verify} use:focusFirst>
          <div class="top"><span class="micro">Create wallet · Step 3 of 3</span></div>
          <h2 id="wizard-title">Check your paper copy</h2>
          <p class="note">Type these words from what you wrote down.</p>
          <div class="checks">
            {#each checks as check (check.index)}
              <div class="field">
                <label class="micro" for="check-{check.index}">Word #{check.index + 1}</label>
                <input
                  id="check-{check.index}"
                  class="input mono"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  bind:value={check.value}
                />
              </div>
            {/each}
          </div>
          {#if error}<p class="error-text" role="alert">{error}</p>{/if}
          <div class="row">
            <button
              type="button"
              class="btn"
              onclick={() => {
                error = null
                wroteDown = false
                step = 'seed'
              }}>Show words again</button
            >
            <button class="btn primary" type="submit" disabled={checks.some((c) => !c.value.trim())}>Confirm</button>
          </div>
        </form>
      {:else if step === 'restore'}
        <form class="content" onsubmit={restore} use:focusFirst>
          <div class="top">
            <span class="micro">Restore wallet</span>
            <button type="button" class="x" aria-label="Close" onclick={close} disabled={busy}>✕</button>
          </div>
          <h2 id="wizard-title">Restore from a seed phrase</h2>
          <p class="warn-note">
            Only restore a seed made for mining. The Lithos Client uses this wallet's keys, so don't use your main
            savings wallet.
          </p>
          <div class="field">
            <label class="micro" for="mnemonic">Seed phrase ({restoreWords} words)</label>
            <textarea
              id="mnemonic"
              class="input mono"
              rows="4"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              bind:value={mnemonic}
            ></textarea>
          </div>
          <div class="field">
            <label class="micro" for="restore-password">New wallet password</label>
            <input
              id="restore-password"
              class="input"
              type={showPassword ? 'text' : 'password'}
              autocomplete="new-password"
              bind:value={password}
            />
          </div>
          <div class="field">
            <label class="micro" for="restore-confirm">Repeat password</label>
            <input
              id="restore-confirm"
              class="input"
              type={showPassword ? 'text' : 'password'}
              autocomplete="new-password"
              bind:value={confirmPassword}
            />
          </div>
          <label class="check"><input type="checkbox" bind:checked={showPassword} /> Show password</label>
          {#if mnemonic.trim() && !restoreCountOk}
            <p class="hint">A seed phrase has {MNEMONIC_LENGTHS.join(', ')} words.</p>
          {:else if confirmPassword && passwordProblem}
            <p class="hint">{passwordProblem}</p>
          {/if}
          {#if existingWalletNote}
            <p class="warn-note" role="status">{existingWalletNote}</p>
            <label class="check">
              <input type="checkbox" bind:checked={replaceConfirmed} />
              Set aside the current wallet and restore this seed
            </label>
          {/if}
          {#if error}<p class="error-text" role="alert">{error}</p>{/if}
          <button class="btn primary" type="submit" disabled={busy || passwordProblem !== null || !restoreCountOk}>
            {busy ? 'Restoring…' : 'Restore wallet'}
          </button>
        </form>
      {:else if step === 'keystore'}
        <form class="content" onsubmit={useKeystore} use:focusFirst>
          <div class="top">
            <span class="micro">Use a keystore file</span>
            <button type="button" class="x" aria-label="Close" onclick={close} disabled={busy}>✕</button>
          </div>
          <h2 id="wizard-title">Use an existing keystore</h2>
          <p class="note">
            A keystore is the encrypted wallet file an Ergo node keeps in <span class="mono">.ergo/wallet/keystore</span>.
            The launcher copies it into this node's wallet folder and leaves your file as it is.
          </p>
          <p class="warn-note">
            Only use a wallet made for mining. The Lithos Client signs with this wallet's keys, so don't use your main
            savings wallet.
          </p>
          <div class="pick well">
            <div class="pick-body">
              <span class="micro">Keystore file</span>
              {#if keystore}
                <span class="pick-name mono">{keystore.name}</span>
                <span class="pick-folder mono">{keystore.folder}</span>
              {:else}
                <span class="pick-folder">No file chosen</span>
              {/if}
            </div>
            <button type="button" class="btn small" onclick={chooseKeystore} disabled={busy}>
              {keystore ? 'Change…' : 'Choose file…'}
            </button>
          </div>
          <div class="field">
            <label class="micro" for="keystore-password">Keystore password</label>
            <input
              id="keystore-password"
              class="input"
              type={showPassword ? 'text' : 'password'}
              autocomplete="current-password"
              disabled={busy}
              bind:value={password}
            />
          </div>
          <label class="check"><input type="checkbox" bind:checked={showPassword} /> Show password</label>
          <p class="info-note">
            The node restarts once to load the keystore, then checks this password itself. If it doesn't unlock, the copy
            is taken out again. Afterwards the wallet scans the chain for its history, which can take a while.
          </p>
          {#if error}<p class="error-text" role="alert">{error}</p>{/if}
          <button class="btn primary" type="submit" disabled={busy || !keystore || !password}>
            {busy ? 'Restarting the node to load it…' : 'Use this keystore'}
          </button>
        </form>
      {:else}
        <div class="content done" use:focusFirst>
          <div class="big-tick" aria-hidden="true">✓</div>
          <h2 id="wizard-title">Wallet ready</h2>
          <p class="note">
            {mode === 'restore'
              ? 'Your wallet is restored and unlocked. Balances appear as the node syncs.'
              : mode === 'keystore'
                ? 'Your keystore is loaded and unlocked. The wallet is scanning the chain for its history, so the balance fills in as it goes.'
                : replacedExisting
                  ? 'Your wallet is created and unlocked. The previous wallet is still on disk. Keep your paper copy somewhere safe and offline.'
                  : 'Your wallet is created and unlocked. Keep your paper copy somewhere safe and offline.'}
          </p>
          {#if ui.wallet.address}
            <div class="field">
              <span class="micro">Mining address</span>
              <code class="mono addr">{ui.wallet.address}</code>
            </div>
          {:else if mode === 'create'}
            <p class="note">The mining address shows on the wallet card once the node finishes unlocking it.</p>
          {/if}
          <button class="btn primary" onclick={close}>Finish</button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Same look as Modal; the wizard keeps its own overlay so it can refuse to close mid-seed. */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(4, 6, 13, 0.88);
  }

  .dialog {
    display: flex;
    flex-direction: column;
    width: min(580px, 100%);
    max-height: 100%;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: 22px;
    background: var(--surface);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
  }

  /* The frame clips and this scrolls, so the scrollbar stays inside the rounded border. */
  .scroll {
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .scroll::-webkit-scrollbar-track {
    margin: 18px 0;
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px 28px 28px;
  }

  .addr {
    display: block;
    overflow-wrap: anywhere;
    color: var(--text-head);
    font-size: 12px;
    line-height: 1.45;
    white-space: normal;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 24px;
  }

  .x {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 50%;
    background: none;
    color: var(--dim);
    font-size: 13px;
    cursor: pointer;
  }

  .x:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text-head);
  }

  h2 {
    margin: 0;
    color: var(--text-head);
    font-family: var(--display);
    font-size: 23px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }

  .hint {
    margin: 0;
    color: var(--amber-light);
    font-size: 12px;
  }

  .warnings {
    padding-left: 30px;
  }

  .warnings li + li {
    margin-top: 4px;
  }

  .words {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .words li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 9px 12px;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--well);
    user-select: text;
  }

  .n {
    min-width: 18px;
    color: var(--dim);
    font-size: 10.5px;
    text-align: right;
  }

  .w {
    color: var(--text-head);
    font-size: 13.5px;
    font-weight: 500;
  }

  .masked .w {
    color: var(--muted);
    filter: blur(3px);
    user-select: none;
  }

  .reveal {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
  }

  .reveal .btn {
    user-select: none;
  }

  .checks {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  textarea.input {
    resize: vertical;
    line-height: 1.6;
  }

  .pick {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 10px 10px 14px;
  }

  .pick-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .pick-name {
    overflow: hidden;
    color: var(--text-head);
    font-size: 12.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pick-folder {
    overflow-wrap: anywhere;
    color: var(--dim);
    font-size: 11.5px;
  }

  .done {
    align-items: center;
    padding-top: 36px;
    text-align: center;
  }

  .big-tick {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--mint);
    box-shadow: 0 0 40px rgba(110, 231, 183, 0.45);
    color: #04111f;
    font-size: 28px;
    font-weight: 700;
  }

  .done .btn {
    min-width: 200px;
  }
</style>
