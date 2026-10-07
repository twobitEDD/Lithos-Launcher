import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** The gear's open/closed flag lives in the Svelte card, so lock the default and the markup guard. */
test('wallet panel keeps management behind a closed gear', async () => {
  const source = await readFile(new URL('../renderer/src/lib/WalletCard.svelte', import.meta.url), 'utf8')
  assert.match(source, /let manageOpen = \$state\(false\)/)
  assert.match(source, /aria-label="Wallet settings"/)
  assert.match(source, /aria-expanded=\{manageOpen\}/)
  const managed = source.match(/\{#if manageOpen\}[\s\S]*?\{\/if\}/g) ?? []
  assert.equal(
    managed.some((block) => block.includes('<WalletList />')),
    true
  )
  const outside = source.replace(/\{#if manageOpen\}[\s\S]*?\{\/if\}/g, '')
  assert.equal(outside.includes('<WalletList'), false)
})
