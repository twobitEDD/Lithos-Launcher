<script lang="ts">
  import {
    DEFAULT_BACKEND_PREFERENCE,
    gpuBackendHint,
    type MinerBackendPreference
  } from '@shared/soatMiner'
  import { setMinerBackend, ui } from './store.svelte'

  // Auto / CUDA / Vulkan for soat-miner vs soat-miner-vk. The SOAT service keeps the choice, so the
  // miner card, Settings and the SOAT Miner window all show the same one.
  let { idPrefix = 'gpu' }: { idPrefix?: string } = $props()

  const m = $derived(ui.miner)
  const choice = $derived<MinerBackendPreference>(m.backendPreference ?? DEFAULT_BACKEND_PREFERENCE)
  const serviceKnows = $derived(m.backendPreference !== undefined)
  const hint = $derived(gpuBackendHint({ preference: choice, gpu: m.gpu, autoBackend: m.autoBackend ?? null }))
  let busy = $state(false)

  async function apply(next: MinerBackendPreference): Promise<void> {
    if (next === choice && serviceKnows) return
    busy = true
    try {
      await setMinerBackend(next)
    } finally {
      busy = false
    }
  }

  const OPTIONS: { value: MinerBackendPreference; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'cuda', label: 'CUDA' },
    { value: 'vulkan', label: 'Vulkan' }
  ]
</script>

<div class="gpu-backend">
  <div class="head">
    <span class="micro" id="{idPrefix}-label">GPU backend</span>
    <div class="seg" role="radiogroup" aria-labelledby="{idPrefix}-label">
      {#each OPTIONS as opt (opt.value)}
        <button
          type="button"
          role="radio"
          aria-checked={choice === opt.value}
          class:on={choice === opt.value}
          disabled={busy}
          title={opt.value === 'auto'
            ? 'Pick CUDA or Vulkan from this computer\'s GPU (NVIDIA before Blackwell → CUDA; Blackwell, AMD, Intel → Vulkan)'
            : opt.value === 'cuda'
              ? 'Force soat-miner (CUDA). Needs an NVIDIA GPU. Stays Waiting if CUDA cannot run.'
              : 'Force soat-miner-vk (Vulkan). Use this on AMD cards and any machine that cannot run CUDA.'}
          onclick={() => void apply(opt.value)}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  </div>
  <p class="micro facts">{hint}</p>
  {#if m.backendNote}<p class="micro note" role="status">{m.backendNote}</p>{/if}
  {#if !serviceKnows && m.service?.reachable}
    <p class="micro facts">
      The SOAT service running now is older than this window; it uses this choice after it restarts.
    </p>
  {/if}
</div>

<style>
  .gpu-backend {
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

  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
    border-radius: 999px;
    background: rgba(10, 15, 30, 0.7);
  }

  .seg button {
    padding: 5px 14px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--muted, #8b93a7);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .seg button:hover:not(:disabled):not(.on) {
    color: var(--sky-light, #7dd3fc);
  }

  .seg button:disabled {
    cursor: not-allowed;
  }

  .seg button.on {
    background: rgba(56, 189, 248, 0.16);
    color: var(--sky-light, #7dd3fc);
    font-weight: 600;
  }

  .gpu-backend p {
    margin: 0;
  }

  .facts {
    color: var(--muted, #8b93a7);
  }

  .note {
    color: var(--text, #e8eaef);
  }
</style>
