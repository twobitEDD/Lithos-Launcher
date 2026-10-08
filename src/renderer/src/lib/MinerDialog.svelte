<script lang="ts">
  import { soatMinerCommand } from '@shared/soatMiner'
  import { DEFAULT_REDUCTION_MULTIPLIER } from '@shared/types'
  import Modal from './Modal.svelte'
  import { copyText, ui } from './store.svelte'

  const port = $derived(ui.client.ports?.stratum ?? ui.clientSettings?.stratumPort ?? 4444)
  const remote = $derived(ui.remoteLauncher)
  const lanHost = $derived(ui.lanAddresses[0] ?? null)
  const localUrl = $derived(
    remote ? `stratum+tcp://${remote.host}:${remote.port}` : `stratum+tcp://127.0.0.1:${port}`
  )
  const lanUrl = $derived(remote ? null : lanHost ? `stratum+tcp://${lanHost}:${port}` : null)
  const soatPool = $derived(remote ? `${remote.host}:${remote.port}` : `${lanHost ?? '127.0.0.1'}:${port}`)
  const soatCmd = $derived(soatMinerCommand(soatPool))
  const rigel = $derived(`rigel -a autolykos2 -o ${localUrl} -u lithos -w rig1`)
  const vram = $derived(ui.network === 'mainnet' ? 'about 6.6 GB' : 'about 2 GB')
  const multiplier = $derived(ui.clientSettings?.reductionMultiplier ?? DEFAULT_REDUCTION_MULTIPLIER)

  let copied = $state<string | null>(null)

  async function copy(text: string): Promise<void> {
    await copyText(text)
    copied = text
    setTimeout(() => (copied = null), 1500)
  }
</script>

<Modal labelledby="miner-title" onclose={() => (ui.dialog = null)} width={640}>
  <div class="content">
    <div class="top">
      <span class="micro">Mining · {ui.network}</span>
      <button class="x" aria-label="Close" onclick={() => (ui.dialog = null)}>✕</button>
    </div>
    <h2 id="miner-title">Connect your miner</h2>
    <p class="note">
      {#if remote}
        Another Lithos launcher is already running. This computer's miner uses that stratum instead of 127.0.0.1:{port}.
        The wallet address and worker name you give your miner don't matter to Lithos: payouts follow the committed
        difficulty on that launcher.
      {:else}
        The Lithos Client runs the pool's stratum server on this computer. Point any Autolykos 2 miner at it. The wallet
        address and worker name you give your miner don't matter to Lithos: payouts follow your committed difficulty.
      {/if}
    </p>

    <div class="urls">
      {#if lanUrl}
        <div class="url">
          <span class="micro">Rigs on your network</span>
          <code class="mono">{lanUrl}</code>
          <button class="btn small" onclick={() => copy(lanUrl!)}>{copied === lanUrl ? 'Copied' : 'Copy'}</button>
        </div>
      {/if}
      <div class="url">
        <span class="micro">{remote ? "This computer's miner" : 'This computer'}</span>
        <code class="mono">{localUrl}</code>
        <button class="btn small" onclick={() => copy(localUrl)}>{copied === localUrl ? 'Copied' : 'Copy'}</button>
      </div>
    </div>

    <section class="miner">
      <div class="miner-head">
        <h3>SOAT Miner <span class="tag micro">recommended</span></h3>
        <button class="link micro" onclick={() => window.lithos.openLink('soat')}>GitHub ↗</button>
      </div>
      <p class="note">
        Open source, no dev fee, built-in Lithos support. On each rig, run this with <code class="mono">--lithos</code> so
        the miner uses this Lithos stratum. The worker name is only a label.
      </p>
      <div class="url">
        <code class="mono">{soatCmd}</code>
        <button class="btn small" onclick={() => copy(soatCmd)}>{copied === soatCmd ? 'Copied' : 'Copy'}</button>
      </div>
    </section>

    <section class="miner">
      <div class="miner-head">
        <h3>Rigel</h3>
        <button class="link micro" onclick={() => window.lithos.openLink('rigel')}>GitHub ↗</button>
      </div>
      <p class="note">Closed source with a dev fee, but tested and known to work:</p>
      <div class="url">
        <code class="mono">{rigel}</code>
        <button class="btn small" onclick={() => copy(rigel)}>{copied === rigel ? 'Copied' : 'Copy'}</button>
      </div>
    </section>

    <p class="note">
      <b>Your miner will show a much higher difficulty than yours.</b> The stratum sends it
      {multiplier.toLocaleString('en-US')}× your difficulty so it reports {multiplier >= 10000
        ? 'only super shares'
        : 'fewer shares'}. That's normal, and Lithos still pays on your difficulty. For a steadier hashrate reading
      in your miner,
      <button class="link inline" onclick={() => (ui.dialog = 'shares')}>adjust share reporting</button>.
    </p>

    <p class="warn-note">
      <b>Check your GPU memory.</b> Autolykos 2 needs {vram} of VRAM on {ui.network}, briefly about double while it
      rebuilds its table. NVIDIA cards that run short keep going at a fraction of their hashrate with no error, so if
      your hashrate is far below normal, this is the first thing to check.
    </p>
    {#if ui.platform === 'win32'}
      <p class="note">
        Windows may ask whether Java can use the network. Choose <b>Allow</b> on private networks so rigs on other
        computers can reach the stratum.
      </p>
    {/if}

    <div class="footer">
      <button class="btn primary" onclick={() => (ui.dialog = null)}>Done</button>
    </div>
  </div>
</Modal>

<style>
  .urls {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .url {
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 7px 8px 7px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well);
  }

  .url code {
    overflow: hidden;
    color: var(--sky-light);
    font-size: 12.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .miner {
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: rgba(15, 22, 41, 0.5);
  }

  .miner .url {
    grid-template-columns: minmax(0, 1fr) auto;
    margin-top: 10px;
  }

  .miner-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .tag {
    margin-left: 6px;
    padding: 1px 7px;
    border: 1px solid rgba(110, 231, 183, 0.35);
    border-radius: 999px;
    color: var(--mint);
    font-size: 9px;
    vertical-align: 2px;
  }

  .link.inline {
    font: inherit;
    text-decoration: underline;
  }

  .note code {
    color: var(--text-head);
  }
</style>
