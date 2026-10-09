<script lang="ts">
  import { onMount } from 'svelte'
  import logo from './assets/lithos-mark.png'
  import ClientCard from './lib/ClientCard.svelte'
  import CommitDialog from './lib/CommitDialog.svelte'
  import DifficultyDialog from './lib/DifficultyDialog.svelte'
  import ImportDialog from './lib/ImportDialog.svelte'
  import LogPanel from './lib/LogPanel.svelte'
  import MinerCard from './lib/MinerCard.svelte'
  import MinerDialog from './lib/MinerDialog.svelte'
  import NetworkSwitch from './lib/NetworkSwitch.svelte'
  import NodeCard from './lib/NodeCard.svelte'
  import QuickSetup from './lib/QuickSetup.svelte'
  import SettingsDialog from './lib/SettingsDialog.svelte'
  import ShareDialog from './lib/ShareDialog.svelte'
  import SetupCard from './lib/SetupCard.svelte'
  import VersionsDialog from './lib/VersionsDialog.svelte'
  import WalletCard from './lib/WalletCard.svelte'
  import WalletSyncDialog from './lib/WalletSyncDialog.svelte'
  import WalletWizard from './lib/WalletWizard.svelte'
  import { clientRequirements, init, startClient, ui } from './lib/store.svelte'

  let loadError = $state<string | null>(null)

  onMount(() => {
    init().catch((err: unknown) => (loadError = err instanceof Error ? err.message : String(err)))
  })

  const nodeUp = $derived(ui.node.status === 'running')

  // Start the client by itself once everything it needs is ready: at most once per node run, never
  // after a crash or after the user stopped it, and in whichever mode it last ran. Real mining also
  // waits for the wallet to catch up. A Start the user chose to hold until then goes through here
  // too (as real mining), and lapses if the node stops.
  let autoStartedFor: number | null = null
  $effect(() => {
    const nodePid = ui.node.status === 'running' ? ui.node.pid : null
    if (nodePid === null || ui.client.status !== 'stopped') {
      if (nodePid === null) autoStartedFor = null
      ui.startWhenWalletSynced = false
      return
    }
    if (ui.remoteLauncher) return
    const requirements = clientRequirements()
    const testMode = ui.clientSettings?.forceConfigDiff ?? false
    if (ui.startWhenWalletSynced) {
      if (requirements.every((r) => r.ok)) {
        autoStartedFor = nodePid
        ui.startWhenWalletSynced = false
        void startClient(false)
      }
    } else if (ui.autoStartClient && autoStartedFor !== nodePid && requirements.every((r) => r.ok || (r.soft && testMode))) {
      autoStartedFor = nodePid
      void startClient()
    }
  })
</script>

<div class="app">
  <header class="topbar">
    <div class="brand">
      <img class="logo" class:alive={nodeUp} src={logo} alt="" width="40" height="40" />
      <div>
        <h1>Lithos<span class="grad-word">Launcher</span></h1>
        <div class="micro">Ergo node · Lithos Client</div>
      </div>
    </div>

    <div class="spacer"></div>

    <div class="controls">
      <NetworkSwitch disabled={ui.installing || ui.switching !== null} />
      <div class="row">
        {#if ui.vault}
          <div
            class="keys micro"
            class:warn={!ui.vault.secure}
            title={ui.vault.secure
              ? `Keys are encrypted by your operating system (${ui.vault.backend}).`
              : 'No system keyring found. Keys are kept in memory for this session only.'}
          >
            <span class="dot" aria-hidden="true"></span>
            {ui.vault.secure ? 'Keys · OS encrypted' : 'Keys · Session only'}
          </div>
        {/if}
        <button class="btn small with-icon" onclick={() => (ui.dialog = 'settings')}>
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
          </svg>
          Settings
        </button>
        <button
          class="btn small with-icon"
          title="Stop the node and client safely, then quit"
          onclick={() => void window.lithos.quit()}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path d="M12 3v8M6.4 6.6a8 8 0 1 0 11.2 0" />
          </svg>
          Quit
        </button>
      </div>
    </div>
  </header>

  {#if loadError}
    <p class="error-text load-error" role="alert">{loadError}</p>
  {/if}

  <main>
    <!-- The frame keeps the column's scrollbar inside a border instead of hanging off the cards. -->
    <div class="side-frame">
      <div class="side">
        <SetupCard />
        <NodeCard />
        <WalletCard />
      </div>
    </div>
    <div class="main-col">
      <ClientCard />
      <MinerCard />
      <LogPanel />
    </div>
  </main>
</div>

{#if ui.quickSetup}
  <QuickSetup />
{/if}

{#if ui.dialog === 'difficulty'}
  <DifficultyDialog />
{:else if ui.dialog === 'commit'}
  <CommitDialog />
{:else if ui.dialog === 'miner'}
  <MinerDialog />
{:else if ui.dialog === 'shares'}
  <ShareDialog />
{:else if ui.dialog === 'settings'}
  <SettingsDialog />
{:else if ui.dialog === 'import'}
  <ImportDialog />
{:else if ui.dialog === 'versions'}
  <VersionsDialog />
{:else if ui.dialog === 'walletSync'}
  <WalletSyncDialog />
{/if}

{#if ui.wizard}
  <WalletWizard />
{/if}

<style>
  /*
   * The body never scrolls (xterm and the fixed glows rely on that); this does, once the window is
   * shorter than the dashboard's minimum. Above that, each column scrolls on its own.
   */
  .app {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .topbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 24px;
    padding: 20px 28px 14px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  h1 {
    margin: 0;
    color: var(--text-head);
    font-family: var(--display);
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1.05;
  }

  .brand .micro {
    margin-top: 3px;
  }

  /*
   * Deliberately still: the window is drawn in software, so any endless animation costs CPU on
   * every frame for as long as the launcher is open. The glow warms to purple while the node runs.
   */
  .logo {
    filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.35));
  }

  .logo.alive {
    filter: drop-shadow(0 0 12px rgba(168, 85, 247, 0.6));
  }

  .spacer {
    flex: 1;
  }

  .controls,
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .keys {
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: default;
  }

  .keys .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--mint);
    box-shadow: 0 0 8px rgba(110, 231, 183, 0.5);
  }

  .keys.warn .dot {
    background: var(--amber);
    box-shadow: 0 0 8px rgba(245, 158, 11, 0.5);
  }

  .with-icon svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  .load-error {
    position: relative;
    margin: 0 24px 12px;
  }

  main {
    position: relative;
    flex: 1 1 0;
    display: grid;
    grid-template-columns: 420px minmax(0, 1fr);
    gap: 20px;
    min-height: 540px;
    padding: 6px 24px 24px;
  }

  /* Client, miner and console stack here; when they don't fit, the column scrolls and the console keeps its height. */
  .main-col {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .main-col > :global(*) {
    flex-shrink: 0;
  }

  @media (max-width: 1100px) {
    main {
      grid-template-columns: 340px minmax(0, 1fr);
      gap: 14px;
      padding: 4px 14px 14px;
    }

    .topbar {
      padding: 14px 18px 10px;
    }
  }

  /* Narrow windows: one column, and the whole page scrolls. */
  @media (max-width: 899px) {
    main {
      flex: none;
      grid-template-columns: minmax(0, 1fr);
      min-height: 0;
    }

    .side-frame,
    .side,
    .main-col {
      overflow: visible;
    }
  }

  /*
   * A recessed tray for the stacked cards. The tray itself clips, so cards scrolling out of view
   * slide under its rounded border rather than being cut on a straight line inside it.
   */
  .side-frame {
    display: flex;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 26px;
    background: rgba(4, 6, 13, 0.55);
  }

  .side {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    padding: 10px 2px 10px 10px;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  /* Keep the scrollbar clear of the tray's rounded corners. */
  .side::-webkit-scrollbar-track {
    margin: 20px 0;
  }
</style>
