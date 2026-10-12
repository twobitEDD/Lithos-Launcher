<script lang="ts">
  import {
    DEFAULT_BACKEND_PREFERENCE,
    UPDATING_SERVICE,
    gpuBackendHint,
    pickVulkanDevice,
    vulkanDeviceBlocked,
    type MinerBackendPreference
  } from '@shared/soatMiner'
  import { setMinerBackend, setVulkanDevice, ui } from './store.svelte'

  // Auto / CUDA / Vulkan for soat-miner vs soat-miner-vk. The SOAT service keeps the choice, so the
  // miner card, Settings and the SOAT Miner window all show the same one.
  let { idPrefix = 'gpu' }: { idPrefix?: string } = $props()

  const m = $derived(ui.miner)
  const choice = $derived<MinerBackendPreference>(m.backendPreference ?? DEFAULT_BACKEND_PREFERENCE)
  const serviceKnows = $derived(m.backendPreference !== undefined)
  const updating = $derived(m.detail === UPDATING_SERVICE)
  const hint = $derived(gpuBackendHint({ preference: choice, gpu: m.gpu, autoBackend: m.autoBackend ?? null }))
  const devices = $derived((m.vulkanDevices ?? []).filter((d) => d.index !== null && d.skipped === null))
  const showDevices = $derived(devices.length > 0 && (choice === 'vulkan' || m.backend === 'vulkan' || m.autoBackend === 'vulkan'))
  const picked = $derived(pickVulkanDevice(m.vulkanDevices ?? [], m.vulkanDevice))
  const blocked = $derived(picked ? vulkanDeviceBlocked(picked) : null)
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
  {#if showDevices}
    <label class="micro device" for="{idPrefix}-vk">
      Vulkan GPU
      <select
        id="{idPrefix}-vk"
        disabled={busy}
        value={m.vulkanDevice === undefined ? '' : String(m.vulkanDevice)}
        onchange={(e) => {
          const v = e.currentTarget.value
          void setVulkanDevice(v === '' ? null : Number(v))
        }}
      >
        <option value="">Auto (largest discrete)</option>
        {#each devices as d (d.index)}
          <option value={String(d.index)}>{d.name} · {d.vramGb.toFixed(1)} GB{d.maxBufferGb !== null ? ` / ${d.maxBufferGb.toFixed(1)} GB buffer` : ''}</option>
        {/each}
      </select>
    </label>
  {/if}
  {#if blocked}<p class="micro note" role="status">{blocked}</p>{/if}
  {#if m.backendNote && m.backendNote !== blocked}<p class="micro note" role="status">{m.backendNote}</p>{/if}
  {#if updating}
    <p class="micro note" role="status">{UPDATING_SERVICE}</p>
  {:else if !serviceKnows && m.service?.reachable}
    <p class="micro facts">
      Saved. The miner service is updating so this choice can apply.
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

  .device {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--muted, #8b93a7);
  }

  .device select {
    max-width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
    border-radius: 6px;
    background: rgba(10, 15, 30, 0.7);
    color: var(--text, #e8eaef);
    font-size: 12px;
  }
</style>
