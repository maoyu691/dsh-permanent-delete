import assert from 'node:assert/strict'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { permanentDeleteSession, confirmationText } from '../lib/delete-session.js'
import { encodeSegment, projectKey } from '../lib/path-format.js'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('encodeSegment matches DSH escaping rules for unsafe ids', () => {
  assert.equal(encodeSegment('abc-DEF_123.x'), 'abc-DEF_123.x')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a/b~c'), 'a~002Fb~007Ec')
})

test('dry run locates session directory without deleting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-'))
  const sessionId = 'session/one'
  const dir = join(root, projectKey('E:\\repo'), encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl'), '{"type":"session"}\n')

  const result = await permanentDeleteSession({ root, sessionId })

  assert.equal(result.deleted, false)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].deleted, false)
  assert.equal(await exists(dir), true)
})

test('delete requires exact confirmation text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-'))
  const sessionId = 'abc'
  const dir = join(root, '_no-cwd', encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })

  await assert.rejects(
    permanentDeleteSession({ root, sessionId, dryRun: false, confirm: 'yes' }),
    /exact confirmation/,
  )
  assert.equal(await exists(dir), true)
})

test('delete removes exactly matched session directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-'))
  const sessionId = 'abc'
  const dir = join(root, '_no-cwd', encodeSegment(sessionId))
  const sibling = join(root, '_no-cwd', encodeSegment('abcd'))
  await mkdir(dir, { recursive: true })
  await mkdir(sibling, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'not-real-zstd')

  const result = await permanentDeleteSession({
    root,
    sessionId,
    dryRun: false,
    confirm: confirmationText(sessionId),
  })

  assert.equal(result.deleted, true)
  assert.equal(result.matches.length, 1)
  assert.equal(await exists(dir), false)
  assert.equal(await exists(sibling), true)
})
