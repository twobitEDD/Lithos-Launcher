<script lang="ts">
  import { PICKS, blocksAsTime, diffFor, fmtConfigDiff, miningSeconds, parseHashrate } from '@shared/mining'
  import type { Network, SystemCheck, TaskId } from '@shared/types'
  import { fmtBytesGB, fmtMB } from './format'
  import Modal from './Modal.svelte'
  import ProgressBar from './ProgressBar.svelte'
  import { install, saveClientSettings, setAutoStartClient, setNetwork, startNode, ui } from './store.svelte'

  type Step = 'welcome' | 'network' | 'check' | 'hashrate' | 'install' | 'node' | 'done'
  const STEPS: Step[] = ['network', 'check', 'hashrate', 'install', 'node', 'done']

  // Rough needs; the indexed node grows with the chain. Tune once mainnet sizes are measured.
  const DISK_GB: Record<Network, number> = { mainnet: 60, testnet: 30 }
  const RAM_GB = 8
  const GB = 2 ** 30

  let step = $state<Step>('welcome')
  let check = $state<SystemCheck | null>(null)
  let checking = $state(false)
  let hashrateText = $state('')
  let error = $state<string | null>(null)

  const stepNo = $derived(STEPS.indexOf(step) + 1)
  const hashrate = $derived(parseHashrate(hashrateText))
  const startDiff = $derived(
    hashrate ? fmtConfigDiff(diffFor(hashrate, miningSeconds(ui.network), PICKS[0].mean)) : null
  )
  const installed = $derived(
    Boolean(ui.net?.java.installed && ui.net?.node.installed && ui.net?.client.installed)
  )
  const nodeRunning = $derived(ui.node.status === 'running' && ui.node.network === ui.network)
  const walletReady = $derived(ui.wallet.phase === 'unlocked' && ui.wallet.network === ui.network)

  const memOk = $derived(check ? check.totalMemBytes >= RAM_GB * GB * 0.95 : true)
  const diskOk = $derived(check?.freeDiskBytes == null ? true : check.freeDiskBytes >= DISK_GB[ui.network] * GB)
  const blockedPorts = $derived(check ? check.ports.filter((p) => !p.free) : [])

  const TASKS: { id: TaskId; label: string }[] = [
    { id: 'java', label: 'Java 11 runtime' },
    { id: 'node', label: 'Ergo node' },
    { id: 'client', label: 'Lithos Client' }
  ]

  function close(): void {
    if (!ui.installing) ui.quickSetup = false
  }

  async function chooseNetwork(network: Network): Promise<void> {
    await setNetwork(network)
    step = 'check'
    checking = true
    check = await window.lithos.getSystemCheck(network)
    checking = false
  }

  async function saveHashrate(): Promise<void> {
    error = null
    if (startDiff) error = await saveClientSettings({ diff: startDiff })
    if (!error) step = 'install'
  }

  async function runInstall(): Promise<void> {
    await install()
    if (installed) step = 'node'
  }

  function finish(): void {
    setAutoStartClient(true)
    ui.quickSetup = false
  }
</script>

<Modal labelledby="qs-title" onclose={ui.wizard ? undefined : close} width={640}>
  <div class="content">
    <div class="top">
      <span class="micro">{step === 'welcome' ? 'Welcome' : `Quick setup · Step ${stepNo} of ${STEPS.length}`}</span>
      <button class="x" aria-label="Close" onclick={close} disabled={ui.installing}>✕</button>
    </div>

    {#if step === 'welcome'}
      <h2 id="qs-title">Let's get you mining on <span class="flow-word">Lithos</span></h2>
      <p class="note">The launcher sets everything up for you:</p>
      <ol class="plan">
        <li>Downloads Java, the Ergo node and the Lithos Client (about 230 MB), checking each download.</li>
        <li>Creates a wallet for mining and helps you back up its seed phrase.</li>
        <li>Syncs the node. The first sync takes a while, and the launcher shows its progress.</li>
        <li>Starts the Lithos Client once the node is ready, so your miner can connect.</li>
      </ol>
      <div class="footer">
        <button class="btn" onclick={close}>I'll set it up myself</button>
        <button
          class="btn"
          onclick={() => {
            ui.quickSetup = false
            ui.dialog = 'import'
          }}>I already have a node</button
        >
        <button class="btn primary" onclick={() => (step = 'network')}>Start quick setup</button>
      </div>
    {:else if step === 'network'}
      <h2 id="qs-title">Which network?</h2>
      <div class="cards">
        <button class="card mainnet" onclick={() => chooseNetwork('mainnet')}>
          <span class="micro">Mainnet</span>
          <span class="card-title">Mine for real</span>
          <span class="note">Real ERG and LIT rewards.</span>
        </button>
        <button class="card testnet" onclick={() => chooseNetwork('testnet')}>
          <span class="micro">Testnet</span>
          <span class="card-title">Practice first</span>
          <span class="note">Test coins with no value. A good way to learn how Lithos works.</span>
        </button>
      </div>
    {:else if step === 'check'}
      <h2 id="qs-title">Checking this computer</h2>
      {#if checking || !check}
        <ProgressBar value={null} label="Checking" />
      {:else}
        <ul class="checks">
          <li class:warn={!memOk}>
            <span class="mark" aria-hidden="true">{memOk ? '✓' : '!'}</span>
            <span>Memory: <b>{fmtBytesGB(check.totalMemBytes)}</b></span>
            <span class="why">{memOk ? '' : `The node and client need about ${RAM_GB} GB together.`}</span>
          </li>
          <li class:warn={!diskOk}>
            <span class="mark" aria-hidden="true">{diskOk ? '✓' : '!'}</span>
            <span>
              Free disk space: <b>{check.freeDiskBytes === null ? 'unknown' : fmtBytesGB(check.freeDiskBytes)}</b>
            </span>
            <span class="why">
              {diskOk ? '' : `The ${ui.network} node needs about ${DISK_GB[ui.network]} GB, and it grows over time.`}
            </span>
          </li>
          <li class:warn={blockedPorts.length > 0}>
            <span class="mark" aria-hidden="true">{blockedPorts.length ? '!' : '✓'}</span>
            <span>Network ports: <b>{blockedPorts.length ? 'some in use' : 'all free'}</b></span>
            <span class="why">
              {blockedPorts.map((p) => `${p.label} (${p.port})`).join(', ')}
              {blockedPorts.length ? ' in use. Is another node or client running?' : ''}
            </span>
          </li>
        </ul>
        <p class="note">Installs to <code class="mono">{check.installRoot}</code></p>
        {#if ui.platform === 'win32'}
          <p class="info-note">
            Windows will ask whether Java may use the network when the node and client first start. Choose
            <b>Allow</b> for private networks so the node can find peers and your mining rigs can connect.
          </p>
        {/if}
        <div class="footer">
          <button class="btn" onclick={() => (step = 'network')}>Back</button>
          <button class="btn primary" onclick={() => (step = 'hashrate')}>
            {memOk && diskOk && !blockedPorts.length ? 'Continue' : 'Continue anyway'}
          </button>
        </div>
      {/if}
    {:else if step === 'hashrate'}
      <h2 id="qs-title">How fast is your miner?</h2>
      <p class="note">
        Your hashrate sets your mining difficulty, which decides how much and how often Lithos pays you. The launcher
        picks the recommended starting value; you can fine-tune it later.
      </p>
      <div class="field">
        <label class="micro" for="qs-hashrate">Hashrate</label>
        <input
          id="qs-hashrate"
          class="input mono"
          placeholder="e.g. 150 MH/s"
          autocomplete="off"
          spellcheck="false"
          bind:value={hashrateText}
        />
      </div>
      {#if startDiff}
        <p class="ok-note">Starting difficulty: <b class="mono">{startDiff}</b></p>
      {:else if hashrateText.trim()}
        <p class="note">Add a unit: 150 MH/s, 150M or 1.2 GH/s</p>
      {/if}
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <div class="footer">
        <button class="btn" onclick={() => (step = 'install')}>I don't know yet</button>
        <button class="btn primary" onclick={saveHashrate} disabled={!startDiff}>Continue</button>
      </div>
    {:else if step === 'install'}
      <h2 id="qs-title">Installing</h2>
      <ul class="tasks">
        {#each TASKS as t (t.id)}
          {@const p = ui.progress[t.id]}
          {@const done = t.id === 'java' ? ui.net?.java.installed : t.id === 'node' ? ui.net?.node.installed : ui.net?.client.installed}
          <li>
            <div class="task-row">
              <span>{t.label}</span>
              <span class="mono dim">
                {#if done}✓ installed{:else if p?.phase === 'downloading'}{fmtMB(p.received)} / {fmtMB(p.total)} MB{:else if p}{p.phase}…{:else}waiting{/if}
              </span>
            </div>
            {#if p && !done && p.phase !== 'error'}
              <ProgressBar
                value={p.phase === 'downloading' && p.total ? (p.received ?? 0) / p.total : null}
                label="{t.label} progress"
              />
            {/if}
          </li>
        {/each}
      </ul>
      {#if ui.setupError}<p class="error-text" role="alert">{ui.setupError}</p>{/if}
      <div class="footer">
        {#if installed}
          <button class="btn primary" onclick={() => (step = 'node')}>Continue</button>
        {:else}
          <button class="btn primary" onclick={runInstall} disabled={ui.installing}>
            {ui.installing ? 'Installing…' : ui.setupError ? 'Try again' : 'Install'}
          </button>
        {/if}
      </div>
    {:else if step === 'node'}
      <h2 id="qs-title">Start the node and create your wallet</h2>
      <ol class="plan">
        <li class:done={nodeRunning}>
          {#if nodeRunning}
            Node running.
          {:else}
            Start the Ergo node. {ui.node.detail ?? ''}
          {/if}
        </li>
        <li class:done={walletReady}>
          {walletReady
            ? 'Wallet ready.'
            : 'Create a wallet made just for mining and back up its seed phrase, or bring one you already have.'}
        </li>
      </ol>
      {#if ui.nodeError}<p class="error-text" role="alert">{ui.nodeError}</p>{/if}
      <div class="footer">
        {#if !nodeRunning}
          <button class="btn primary" onclick={startNode} disabled={ui.node.status === 'starting'}>
            {ui.node.status === 'starting' ? 'Starting…' : 'Start node'}
          </button>
        {:else if ui.wallet.phase === 'uninitialized' && ui.wallet.network === ui.network}
          {@const sameKey = Boolean(ui.wallet.address) || ui.wallet.hasPeerWallet}
          <button class="btn" onclick={() => (ui.wizard = 'keystore')}>Use keystore file</button>
          <button class="btn" class:primary={sameKey} onclick={() => (ui.wizard = 'restore')}>
            {sameKey ? 'Restore the same seed phrase' : 'Restore seed phrase'}
          </button>
          {#if !sameKey}
            <button class="btn primary" onclick={() => (ui.wizard = 'create')}>Create wallet</button>
          {/if}
        {:else if walletReady}
          <button class="btn primary" onclick={() => (step = 'done')}>Continue</button>
        {:else}
          <button class="btn primary" disabled>Waiting for the wallet…</button>
        {/if}
      </div>
    {:else}
      <div class="big-tick" aria-hidden="true">✓</div>
      <h2 id="qs-title" class="center">You're set up</h2>
      <ul class="plan next">
        <li>
          <b>The node is syncing.</b> The first sync takes a while (it can be many hours), and the progress is on the
          dashboard. Leave the launcher running.
        </li>
        <li><b>The Lithos Client starts by itself</b> once the node is fully synced and indexed.</li>
        <li>
          <b>Then connect your miner</b> and watch your super shares. When they look right, commit your difficulty to
          start earning. It locks for {blocksAsTime(845, ui.network)}, so it's worth checking first.
        </li>
      </ul>
      <div class="footer">
        <button class="btn primary" onclick={finish}>Go to dashboard</button>
      </div>
    {/if}
  </div>
</Modal>

<style>
  .plan {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding-left: 20px;
    color: var(--text);
    font-size: 13px;
  }

  .plan li.done {
    color: var(--mint);
  }

  .plan.next {
    list-style: none;
    padding: 0;
  }

  .plan b {
    color: var(--text-head);
  }

  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 18px 20px;
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    background: var(--well);
    color: var(--text);
    text-align: left;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background 0.15s,
      box-shadow 0.2s;
  }

  .card.mainnet:hover {
    border-color: var(--sky);
    background: rgba(56, 189, 248, 0.07);
    box-shadow: 0 0 22px rgba(56, 189, 248, 0.18);
  }

  .card.testnet:hover {
    border-color: var(--purple);
    background: rgba(168, 85, 247, 0.08);
    box-shadow: 0 0 22px rgba(168, 85, 247, 0.2);
  }

  .card.mainnet .micro {
    color: var(--sky-light);
  }

  .card.testnet .micro {
    color: var(--purple-light);
  }

  .card-title {
    color: var(--text-head);
    font-family: var(--display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.03em;
  }

  .checks {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .checks li {
    display: grid;
    grid-template-columns: 20px auto 1fr;
    align-items: baseline;
    gap: 10px;
  }

  .mark {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 5px;
    background: var(--mint);
    color: #04111f;
    font-size: 11px;
    font-weight: 700;
  }

  .warn .mark {
    background: var(--amber);
  }

  .checks b {
    color: var(--text-head);
    font-weight: 600;
  }

  .why {
    color: var(--amber-light);
    font-size: 12px;
  }

  .tasks {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .task-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
    color: var(--text-head);
  }

  .dim {
    color: var(--dim);
    font-size: 11.5px;
  }

  .big-tick {
    display: grid;
    place-items: center;
    align-self: center;
    width: 56px;
    height: 56px;
    margin-top: 12px;
    border-radius: 50%;
    background: var(--mint);
    box-shadow: 0 0 40px rgba(110, 231, 183, 0.45);
    color: #04111f;
    font-size: 28px;
    font-weight: 700;
  }

  .center {
    text-align: center;
  }
</style>
