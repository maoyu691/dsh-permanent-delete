import { join } from 'node:path'

export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('session id must be a non-empty string')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'

  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cwd must be a non-empty string')
  }

  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }

  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

export function projectDir(root, cwd) {
  return cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
}

export function sessionDir(root, cwd, sessionId) {
  return join(projectDir(root, cwd), encodeSegment(sessionId))
}
