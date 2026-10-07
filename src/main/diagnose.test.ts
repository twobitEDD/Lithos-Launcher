import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diagnose } from './diagnose.ts'

test('client config rejection includes the setting and the reason, not only the summary', () => {
  const message = diagnose('client', [
    'configs.ConfigValidationException: ',
    'The client found 1 configuration problem and cannot start safely:',
    '',
    '  node.storagePath',
    "      no secret storage could be loaded from '/tmp/missing.json' - point node.storagePath at your node's wallet keystore file",
    '\tat configs.Configs$.fail(ConfigValidation.scala:38)'
  ])
  assert.match(message ?? '', /node\.storagePath/)
  assert.match(message ?? '', /no secret storage could be loaded/)
  assert.doesNotMatch(message ?? '', /Configs\$\.fail/)
})
