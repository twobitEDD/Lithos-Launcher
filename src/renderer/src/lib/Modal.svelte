<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    labelledby,
    onclose,
    width = 600,
    children
  }: { labelledby: string; onclose?: () => void; width?: number; children: Snippet } = $props()

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && onclose) onclose()
  }

  /** Moves focus into the dialog: the first field, else the main action, else the first button. */
  function focusFirst(node: HTMLElement): void {
    requestAnimationFrame(() =>
      (
        node.querySelector<HTMLElement>('input, textarea') ??
        node.querySelector<HTMLElement>('.btn.primary:not(:disabled)') ??
        node.querySelector<HTMLElement>('button:not(.x)')
      )?.focus()
    )
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay">
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby={labelledby}
    style:width="min({width}px, 100%)"
    use:focusFirst
  >
    <div class="scroll">{@render children()}</div>
  </div>
</div>

<style>
  /* A plain dim, no backdrop blur: in software rendering a blur recomputes whenever the log behind it scrolls. */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(4, 6, 13, 0.88);
  }

  @media (max-height: 700px), (max-width: 700px) {
    .overlay {
      padding: 10px;
    }
  }

  /* The frame clips and the inner area scrolls, so the scrollbar stays inside the rounded border. */
  .dialog {
    position: relative;
    display: flex;
    flex-direction: column;
    max-height: 100%;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: 22px;
    background: var(--surface);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
  }

  .scroll {
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .scroll::-webkit-scrollbar-track {
    margin: 18px 0;
  }

  .dialog :global(.content) {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px 28px 28px;
  }

  .dialog :global(.top) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 24px;
  }

  .dialog :global(.x) {
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

  .dialog :global(.x:hover:not(:disabled)) {
    border-color: var(--border-strong);
    color: var(--text-head);
  }

  .dialog :global(h2) {
    margin: 0;
    color: var(--text-head);
    font-family: var(--display);
    font-size: 23px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }

  .dialog :global(h3) {
    margin: 0;
    color: var(--text-head);
    font-family: var(--display);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .dialog :global(.footer) {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding-top: 4px;
  }

  /* Label/value rows in a recessed box, shared by several dialogs. */
  .dialog :global(.facts) {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin: 0;
    padding: 13px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well);
    list-style: none;
    font-size: 12.5px;
  }

  .dialog :global(.facts li) {
    display: grid;
    grid-template-columns: 110px minmax(0, 1fr);
    gap: 12px;
  }

  .dialog :global(.facts b) {
    color: var(--text-head);
    font-weight: 600;
  }
</style>
