<script lang="ts">
  import { onMount } from 'svelte'
  import {
    DEFAULT_NODE_API_PORT,
    DEFAULT_NODE_P2P_PORT,
    DEFAULT_OFFLINE_GENERATION,
    DEFAULT_REDUCTION_MULTIPLIER,
    NETWORKS,
    REDUCTION_MULTIPLIERS,
    API_KEY_RE,
    MIN_API_KEY_LENGTH,
    type ApiKeyName,
    type ConfigName,
    type LauncherInfo,
    type NetworkConfigInfo
  } from '@shared/types'
  import Modal from './Modal.svelte'
  import { errorText, refresh, restartClient, saveClientSettings, setShareWalletAcrossNetworks, ui } from './store.svelte'
  import WalletList from './WalletList.svelte'

  const api = window.lithos
  const network = ui.network
  let info = $state<LauncherInfo | null>(null)
  let nodeMb = $state('')
  let clientMb = $state('')
  let offlineGeneration = $state(DEFAULT_OFFLINE_GENERATION[network])
  let apiPort = $state(String(DEFAULT_NODE_API_PORT[network]))
  let p2pPort = $state(String(DEFAULT_NODE_P2P_PORT[network]))
  let httpPort = $state('')
  let stratumPort = $state('')
  let multiplier = $state<number>(DEFAULT_REDUCTION_MULTIPLIER)
  let lanPanel = $state(false)
  let testMode = $state(false)
  let shareWallet = $state(ui.shareWalletAcrossNetworks)
  let config = $state<NetworkConfigInfo | null>(null)
  /** The key being replaced: with a new random one, or with one the user types. */
  let editing = $state<{ name: ApiKeyName; mode: 'new' | 'set' } | null>(null)
  let customKey = $state('')
  let showKey = $state(false)
  let rotating = $state<ApiKeyName | null>(null)
  let message = $state<string | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)

  const KEYS: { name: ApiKeyName; label: string; use: string }[] = [
    {
      name: 'node',
      label: 'Node API key',
      use: 'Unlocks wallet and admin actions in the node panel. The node only accepts it from this computer.'
    },
    {
      name: 'lithos',
      label: 'Lithos API key',
      use: "Lets the Lithos panel claim rewards and place DEX orders. Enter it in the panel's settings."
    }
  ]
  const FILES: { name: ConfigName; file: string; owner: string }[] = [
    { name: 'node', file: 'ergo.conf', owner: 'node' },
    { name: 'client', file: 'lithos.conf', owner: 'client' }
  ]

  const running = $derived(ui.node.status !== 'stopped' && ui.node.status !== 'crashed')
  const nodeRunningHere = $derived(running && ui.node.network === network)
  const clientRunning = $derived(ui.client.status === 'running' && ui.client.network === network)
  // The node hashes every new key, so replacing one needs this network's node up.
  const canReplace = $derived(nodeRunningHere && ui.node.status === 'running')
  // The first address is this computer's main network adapter (virtual ones are listed last).
  const lanUrl = $derived(ui.lanAddresses[0] ? `http://${ui.lanAddresses[0]}:${httpPort || 9000}` : null)

  function loadClientFields(): void {
    const s = ui.clientSettings
    if (!s) return
    httpPort = String(s.httpPort)
    stratumPort = String(s.stratumPort)
    multiplier = s.reductionMultiplier
    lanPanel = s.lanPanel
    testMode = s.forceConfigDiff
  }

  const loadConfig = async (): Promise<void> => {
    config = await api.getConfigInfo(network)
  }

  onMount(() => {
    void (async () => {
      const [launcher, node] = await Promise.all([api.getLauncherInfo(), api.getNodeSettings(network), loadConfig()])
      info = launcher
      nodeMb = info.heapOverridden.node ? String(info.heap.nodeMb) : ''
      clientMb = info.heapOverridden.client ? String(info.heap.clientMb) : ''
      offlineGeneration = node.offlineGeneration
      apiPort = String(node.apiPort)
      p2pPort = String(node.p2pPort)
      shareWallet = info.shareWalletAcrossNetworks
      loadClientFields()
    })()
    // Coming back from an editor: pick up what changed in the config files.
    const onFocus = (): void => void loadConfig()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  })

  async function run(action: () => Promise<string | void>): Promise<void> {
    busy = true
    error = null
    message = null
    try {
      const done = await action()
      if (done) message = done
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }

  const changeRoot = (): Promise<void> =>
    run(async () => {
      if (!(await api.chooseInstallRoot())) return
    })

  const resetRoot = (): Promise<void> => run(() => api.resetInstallRoot())

  const saveHeap = (): Promise<void> =>
    run(async () => {
      const parse = (v: string): number | null => (v.trim() === '' ? null : Number(v))
      info = await api.setHeap({ nodeMb: parse(nodeMb), clientMb: parse(clientMb) })
      return 'Memory settings saved. They apply the next time the node and client start.'
    })

  const saveNode = (): Promise<void> =>
    run(async () => {
      // A blank field means Ergo's default, which the placeholder shows.
      const port = (v: string, fallback: number): number => (v.trim() === '' ? fallback : Number(v))
      const saved = await api.setNodeSettings(network, {
        offlineGeneration,
        apiPort: port(apiPort, DEFAULT_NODE_API_PORT[network]),
        p2pPort: port(p2pPort, DEFAULT_NODE_P2P_PORT[network])
      })
      offlineGeneration = saved.offlineGeneration
      apiPort = String(saved.apiPort)
      p2pPort = String(saved.p2pPort)
      await refresh()
      return nodeRunningHere
        ? 'Saved. Restart the node for it to take effect.'
        : 'Saved. The node uses this the next time it starts.'
    })

  const saveShareWallet = (): Promise<void> =>
    run(async () => {
      await setShareWalletAcrossNetworks(shareWallet)
      info = await api.getLauncherInfo()
      shareWallet = info.shareWalletAcrossNetworks
      return shareWallet
        ? 'Saved. The same mining key is used on mainnet and testnet (addresses rewrite 9… ↔ 3…).'
        : 'Saved. Mainnet and testnet keep separate mining wallets.'
    })

  const saveClient = (): Promise<void> =>
    run(async () => {
      const err = await saveClientSettings({
        httpPort: Number(httpPort),
        stratumPort: Number(stratumPort),
        reductionMultiplier: multiplier,
        lanPanel,
        forceConfigDiff: testMode
      })
      if (err) throw new Error(err)
      loadClientFields()
      if (clientRunning) {
        await restartClient()
        return 'Saved, and the client restarted with the new settings.'
      }
      return 'Saved. The client uses these settings the next time it starts.'
    })

  function startEdit(name: ApiKeyName, mode: 'new' | 'set'): void {
    editing = { name, mode }
    customKey = ''
    showKey = false
  }

  const replaceKey = (name: ApiKeyName): Promise<void> =>
    run(async () => {
      const chosen = editing?.mode === 'set' ? customKey : null
      editing = null
      rotating = name
      try {
        await api.replaceApiKey(network, name, chosen)
      } finally {
        rotating = null
        customKey = ''
        showKey = false
      }
      if (name === 'lithos') {
        return clientRunning
          ? 'New Lithos API key in use; the client restarted with it. Update it wherever you entered the old one.'
          : 'New Lithos API key saved. The client uses it the next time it starts.'
      }
      return ui.autoStartClient
        ? 'The node restarted with its new API key. The Lithos Client starts again once the node is ready.'
        : 'The node restarted with its new API key. Start the Lithos Client again when you are ready.'
    })

  const openConfig = (name: ConfigName, reveal: boolean): Promise<void> => run(() => api.openConfig(network, name, reveal))

  const clearImport = (target: (typeof NETWORKS)[number]): Promise<void> =>
    run(async () => {
      await api.clearImport(target)
      info = await api.getLauncherInfo()
      await refresh()
      return `The ${target} node now uses the launcher's own data folder again.`
    })
</script>

<Modal labelledby="settings-title" onclose={() => !busy && !ui.wizard && (ui.dialog = null)} width={680}>
  <div class="content">
    <div class="top">
      <span class="micro">Settings</span>
      <button class="x" aria-label="Close" onclick={() => (ui.dialog = null)} disabled={busy}>✕</button>
    </div>
    <h2 id="settings-title">Advanced settings</h2>

    {#if !ui.sandboxed}
      <p class="warn-note">
        {ui.appImage
          ? "The AppImage started this window without Chromium's sandbox, because this system blocks what the sandbox needs. Install the .deb package to run it sandboxed."
          : "This window was started with --no-sandbox, which turns off Chromium's sandbox. Start Lithos Launcher without that flag to run it sandboxed."}
      </p>
    {/if}

    <section>
      <h3>Wallets · {network}</h3>
      <WalletList />
    </section>

    {#if !info}
      <p class="note">Loading…</p>
    {:else}
      <section>
        <h3>Install folder</h3>
        <p class="path mono">{info.root}</p>
        <p class="note">
          Java, the node, the client and their data live here. Changing it restarts the launcher; files already
          installed are not moved.
        </p>
        <div class="row">
          <button class="btn small" onclick={changeRoot} disabled={busy || running}>Change…</button>
          {#if info.root !== info.defaultRoot}
            <button class="btn small" onclick={resetRoot} disabled={busy || running}>Use default</button>
          {/if}
          {#if running}<span class="hint">Stop the node first.</span>{/if}
        </div>
      </section>

      <section>
        <h3>Existing setups</h3>
        {#each NETWORKS as n (n)}
          <div class="kv">
            <span class="micro">{n} node data</span>
            {#if info.dataDirs[n]}
              <span class="mono path">{info.dataDirs[n]} <span class="tag">imported</span></span>
              <button class="link micro" onclick={() => clearImport(n)} disabled={busy}>Stop using it</button>
            {:else}
              <span class="dim">Launcher's own folder</span>
            {/if}
          </div>
        {/each}
        <div class="row">
          <button class="btn small" onclick={() => (ui.dialog = 'import')}>Import an existing setup…</button>
        </div>
      </section>

      <section>
        <h3>Memory</h3>
        <p class="note">Maximum Java heap for each program. Leave empty for automatic, sized from this computer's RAM.</p>
        <div class="grid2">
          <div class="field">
            <label class="micro" for="node-mb">Ergo node (MB)</label>
            <input id="node-mb" class="input mono" placeholder="auto: {info.autoHeap.nodeMb}" bind:value={nodeMb} />
          </div>
          <div class="field">
            <label class="micro" for="client-mb">Lithos Client (MB)</label>
            <input id="client-mb" class="input mono" placeholder="auto: {info.autoHeap.clientMb}" bind:value={clientMb} />
          </div>
        </div>
        <div class="row"><button class="btn small" onclick={saveHeap} disabled={busy}>Save memory</button></div>
      </section>

      <section>
        <h3>Wallet</h3>
        <label class="check">
          <input type="checkbox" bind:checked={shareWallet} />
          Use the same mining wallet on mainnet and testnet
        </label>
        <span class="hint">
          One seed, shown as a mainnet address (9…) or a testnet address (3…). When this network has no wallet yet, the
          launcher can copy the other network's keystore. Leave off if you want a separate testnet key.
        </span>
        <div class="row">
          <button class="btn small" onclick={saveShareWallet} disabled={busy}>Save wallet settings</button>
        </div>
      </section>

      <section>
        <h3><span class="swatch network" aria-hidden="true"></span>Ergo node · {network}</h3>
        <div class="grid2">
          <div class="field">
            <label class="micro" for="api-port">Ergo API port</label>
            <input
              id="api-port"
              class="input mono"
              inputmode="numeric"
              placeholder={String(DEFAULT_NODE_API_PORT[network])}
              bind:value={apiPort}
            />
          </div>
          <div class="field">
            <label class="micro" for="p2p-port">Ergo peer port</label>
            <input
              id="p2p-port"
              class="input mono"
              inputmode="numeric"
              placeholder={String(DEFAULT_NODE_P2P_PORT[network])}
              bind:value={p2pPort}
            />
          </div>
        </div>
        <span class="hint">
          Defaults are Ergo's own ({DEFAULT_NODE_API_PORT[network]} API / {DEFAULT_NODE_P2P_PORT[network]} peers). Change
          them if another node already uses those ports (for example a second testnet stack on 9054). The Lithos Client
          is pointed at the API port automatically.
        </span>
        <label class="check">
          <input type="checkbox" bind:checked={offlineGeneration} />
          Offline generation: hand out mining work right after a restart
        </label>
        <span class="hint">
          The node hands out mining work without first waiting for a new block from the network, so mining resumes
          straight away after a restart. Ergo turns this on by default for mainnet{DEFAULT_OFFLINE_GENERATION[network]
            ? ''
            : ' but not for testnet'}.
        </span>
        <div class="row">
          <button class="btn small" onclick={saveNode} disabled={busy}>Save node settings</button>
        </div>
      </section>

      <section>
        <h3><span class="swatch lithos" aria-hidden="true"></span>Lithos Client · {network}</h3>
        <div class="grid2">
          <div class="field">
            <label class="micro" for="http-port">Panel port</label>
            <input id="http-port" class="input mono" bind:value={httpPort} />
          </div>
          <div class="field">
            <label class="micro" for="stratum-port">Stratum port</label>
            <input id="stratum-port" class="input mono" bind:value={stratumPort} />
          </div>
        </div>
        <div class="field">
          <label class="micro" for="multiplier">Share reporting</label>
          <select id="multiplier" class="input" bind:value={multiplier}>
            {#each REDUCTION_MULTIPLIERS as m (m)}
              <option value={m}>
                {m === 10000 ? 'Super shares only (10,000×)' : `${m.toLocaleString('en-US')}× your difficulty`}{m ===
                DEFAULT_REDUCTION_MULTIPLIER
                  ? ' (default)'
                  : ''}
              </option>
            {/each}
          </select>
          <span class="hint">
            Miners are sent this multiple of your difficulty, so they report fewer shares. Lower it if your miner shows
            too few shares for a steady hashrate. What Lithos pays is unchanged.
          </span>
        </div>
        <label class="check">
          <input type="checkbox" bind:checked={lanPanel} />
          Open the Lithos panel to other devices on your network
        </label>
        <span class="hint">
          Lets you check on mining from your phone or another computer on the same Wi-Fi or LAN{lanUrl
            ? `, at ${lanUrl}`
            : ''}. Otherwise the panel only opens on this computer.
        </span>
        {#if lanPanel}
          <p class="warn-note">
            Anyone on your network can open the panel and see its statistics. Actions that spend from the wallet still
            need the client's API key, which the panel sends over plain HTTP, so only enable this on a network you
            trust.{ui.platform === 'win32'
              ? ' If Windows asks whether Java may use the network, allow it on private networks.'
              : ''}
          </p>
        {/if}
        <label class="check">
          <input type="checkbox" bind:checked={testMode} />
          Test mode: mine at the configured difficulty without committing it (forceConfigDiff)
        </label>
        {#if testMode}
          <p class="warn-note">
            Commit your difficulty on chain before mining for real. Turning this off does not accept proofs: an uncommitted difficulty is still rejected, and a config difficulty below your commitment is rejected too.
          </p>
        {/if}
        <div class="row">
          <button class="btn small" onclick={saveClient} disabled={busy}>
            {clientRunning ? 'Save and restart client' : 'Save client settings'}
          </button>
        </div>
      </section>

      <section>
        <h3>API keys · {network}</h3>
        <p class="note">
          Copy a key from its card on the dashboard. Here you can replace one that may have leaked with a new random
          key, or set a key you choose. Either way it is stored only encrypted by your operating system, never in a
          file.
        </p>
        {#each KEYS as k (k.name)}
          <div class="item">
            <div class="item-body">
              <span class="item-name">{k.label}</span>
              <span class="hint">{k.use}</span>
            </div>
            <div class="row">
              <button class="btn small" onclick={() => startEdit(k.name, 'new')} disabled={busy || !canReplace}>
                New key…
              </button>
              <button class="btn small" onclick={() => startEdit(k.name, 'set')} disabled={busy || !canReplace}>
                Set key…
              </button>
            </div>
          </div>
          {#if editing?.name === k.name}
            <form
              class="warn-note confirm"
              onsubmit={(e) => {
                e.preventDefault()
                void replaceKey(k.name)
              }}
            >
              {#if editing.mode === 'set'}
                <div class="field">
                  <label class="micro" for="key-{k.name}">Your {k.name === 'node' ? 'node' : 'Lithos'} API key</label>
                  <input
                    id="key-{k.name}"
                    class="input mono"
                    type={showKey ? 'text' : 'password'}
                    autocomplete="off"
                    spellcheck="false"
                    bind:value={customKey}
                  />
                </div>
                <label class="check"><input type="checkbox" bind:checked={showKey} /> Show key</label>
                {#if customKey && !API_KEY_RE.test(customKey)}
                  <span class="hint">
                    Use at least {MIN_API_KEY_LENGTH} characters: letters, digits and symbols, no spaces.
                  </span>
                {/if}
              {/if}
              <span>
                {#if k.name === 'node'}
                  {editing.mode === 'set' ? 'Use this key for the node?' : 'Replace the node API key?'} The node restarts
                  once{clientRunning ? ', and the Lithos Client stops until the node is back' : ''}. The old key stops
                  working.
                {:else}
                  {editing.mode === 'set' ? 'Use this key for the Lithos Client?' : 'Replace the Lithos API key?'}
                  {clientRunning ? 'The client restarts. ' : ''}The old key stops working, so enter the new one wherever
                  you used the old.
                {/if}
              </span>
              <div class="row">
                <button
                  class="btn small danger"
                  type="submit"
                  disabled={busy || (editing.mode === 'set' && !API_KEY_RE.test(customKey))}
                >
                  {editing.mode === 'set' ? 'Use this key' : 'Replace key'}
                </button>
                <button class="btn small" type="button" onclick={() => (editing = null)} disabled={busy}>Cancel</button>
              </div>
            </form>
          {/if}
        {/each}
        {#if !canReplace}
          <span class="hint">Start the {network} node to replace a key: the node computes each new key's hash.</span>
        {/if}
        {#if rotating}
          <p class="info-note" role="status">
            {rotating === 'node' ? 'Restarting the node with its new key…' : 'Replacing the Lithos API key…'}
          </p>
        {/if}
      </section>

      <section>
        <h3>Config files · {network}</h3>
        <p class="note">
          The launcher only rewrites the marked block at the top of each file. Add your own settings below it: they are
          kept across restarts and client updates, override the launcher's, and apply the next time the node or client
          starts.
        </p>
        {#each FILES as f (f.name)}
          {@const file = config?.files[f.name]}
          <div class="item">
            <div class="item-body">
              <span class="item-name mono">{f.file}</span>
              <span class="path mono">{file?.exists ? file.path : `Created the first time the ${f.owner} starts.`}</span>
            </div>
            <div class="row">
              <button class="btn small" onclick={() => openConfig(f.name, false)} disabled={busy || !file?.exists}>Open</button>
              <button class="btn small" onclick={() => openConfig(f.name, true)} disabled={busy || !file?.exists}>
                Show in folder
              </button>
            </div>
          </div>
          {#if file?.overrides.length}
            <p class="warn-note">
              Your settings in {f.file} override ones the launcher relies on:
              <span class="mono">{file.overrides.join(', ')}</span>. The {f.owner} may not work as expected{f.name ===
              'client'
                ? ', and the settings above may not be what the client actually uses'
                : ''}.
            </p>
          {/if}
        {/each}
        <span class="hint">
          Don't edit conf/application.conf inside the client's release folder: each client update replaces it.
        </span>
      </section>
    {/if}

    {#if message}<p class="ok-note" role="status">{message}</p>{/if}
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
    <div class="footer"><button class="btn primary" onclick={() => (ui.dialog = null)} disabled={busy}>Done</button></div>
  </div>
</Modal>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 18px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: rgba(15, 22, 41, 0.45);
  }

  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .path {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--sky-light);
    font-size: 12px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .kv {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 12px;
    font-size: 12px;
  }

  .tag {
    margin-left: 6px;
    color: var(--mint);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
  }

  .dim,
  .hint {
    color: var(--dim);
    font-size: 11.5px;
  }

  select.input {
    appearance: auto;
  }

  /* A named thing (a key, a file) with its actions on the right. */
  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 10px 10px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well);
  }

  .item-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .item-name {
    color: var(--text-head);
    font-size: 12.5px;
    font-weight: 600;
  }

  .item .row {
    flex: none;
  }

  .confirm {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
</style>
