import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstat, readdir, rm } from 'node:fs/promises'
import { encodeSegment, sessionDir } from './path-format.js'

const DEFAULT_ROOT_ENV = ['DSH_SESSION_ROOT', 'DSH_SESSIONS_ROOT']

export function confirmationText(sessionId) {
  return `PERMANENTLY DELETE ${sessionId}`
}

export function resolveSessionRoot(root) {
  const candidate = root
    ?? DEFAULT_ROOT_ENV.map(name => process.env[name]).find(value => value !== undefined && value !== '')
    ?? (process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'sessions'))
    ?? join(homedir(), '.dsh', 'sessions')

  return resolve(expandHome(candidate))
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('operation aborted')
  }
}

function assertRootContained(root, target) {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to delete outside session root: ${resolvedTarget}`)
  }
}

async function pathExistsAsDirectory(path) {
  try {
    const info = await lstat(path)
    return info.isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function scanDirectoryStats(path, signal) {
  throwIfAborted(signal)
  const info = await lstat(path)
  let fileCount = info.isFile() || info.isSymbolicLink() ? 1 : 0
  let directoryCount = info.isDirectory() ? 1 : 0
  let byteCount = Number(info.size)

  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { fileCount, directoryCount, byteCount }
  }

  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    throwIfAborted(signal)
    const child = join(path, entry.name)
    const childStats = await scanDirectoryStats(child, signal)
    fileCount += childStats.fileCount
    directoryCount += childStats.directoryCount
    byteCount += childStats.byteCount
  }

  return { fileCount, directoryCount, byteCount }
}

async function findMatches(root, sessionId, cwd, signal) {
  throwIfAborted(signal)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory()) throw new Error(`session root is not a directory: ${root}`)

  if (cwd !== undefined) {
    const target = sessionDir(root, cwd, sessionId)
    assertRootContained(root, target)
    return await pathExistsAsDirectory(target) ? [target] : []
  }

  const encoded = encodeSegment(sessionId)
  const projects = await readdir(root, { withFileTypes: true })
  const matches = []
  for (const project of projects) {
    throwIfAborted(signal)
    if (!project.isDirectory()) continue

    const candidate = join(root, project.name, encoded)
    assertRootContained(root, candidate)
    if (await pathExistsAsDirectory(candidate)) matches.push(candidate)
  }
  return matches.sort()
}

export async function permanentDeleteSession(options) {
  const sessionId = options.sessionId?.trim()
  if (!sessionId) throw new Error('sessionId is required')

  const root = resolveSessionRoot(options.root)
  const dryRun = options.dryRun !== false
  const confirmation = confirmationText(sessionId)
  const paths = await findMatches(root, sessionId, options.cwd, options.signal)

  if (paths.length > 1 && options.allowMultipleMatches !== true) {
    throw new Error(
      `found ${paths.length} matching session directories; rerun with allowMultipleMatches=true after checking the dry-run output`,
    )
  }

  if (!dryRun && options.confirm !== confirmation) {
    throw new Error(`refusing permanent delete without exact confirmation: ${confirmation}`)
  }

  const matches = []
  for (const path of paths) {
    throwIfAborted(options.signal)
    assertRootContained(root, path)
    const stats = await scanDirectoryStats(path, options.signal)
    if (!dryRun) {
      await rm(path, { recursive: true, force: false, maxRetries: 3 })
    }
    matches.push({ path, ...stats, deleted: !dryRun })
  }

  return {
    root,
    sessionId,
    deleted: !dryRun,
    confirmation,
    matches,
  }
}

export function moduleRoot(importMetaUrl) {
  return dirname(fileURLToPath(importMetaUrl))
}
