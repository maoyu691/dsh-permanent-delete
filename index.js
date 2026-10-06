import { confirmationText, permanentDeleteSession, resolveSessionRoot } from './lib/delete-session.js'

export const name = 'dsh-permanent-delete'
export const inject = ['tools', 'webServer']

const PACKAGE_ID = 'dsh-permanent-delete'
const ENDPOINT = `/plugins/${PACKAGE_ID}/session`
const MAX_BODY_BYTES = 8 * 1024
const BODY_TIMEOUT_MS = 5_000
const DELETE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESULT_CHARS = 12_000

/* ───────────────────────── 日志（拿到什么用什么，永不抛） ───────────────────────── */

let logger = null

function loggerFor(ctx) {
  try {
    const candidate = ctx?.logger
    if (typeof candidate === 'function') return candidate(PACKAGE_ID) ?? null
    if (candidate && typeof candidate.info === 'function') return candidate
  } catch {
    /* 退回 console */
  }
  return null
}

function say(level, message) {
  const line = `[${PACKAGE_ID}] ${message}`
  try {
    const sink = logger ?? console
    if (typeof sink[level] === 'function') sink[level](line)
  } catch {
    try {
      console.log(line)
    } catch {
      /* 连 console 都没有就只能放弃 */
    }
  }
}

const warn = message => say('warn', message)
const info = message => say('info', message)

/* ───────────────────────── 工具（agent 侧，保持不变） ───────────────────────── */

function renderResult(value) {
  const lines = [
    value.deleted ? 'Permanent deletion completed.' : 'Dry run only; nothing was deleted.',
    `root: ${value.root}`,
    `sessionId: ${value.sessionId}`,
    `matches: ${value.matches.length}`,
  ]

  for (const match of value.matches) {
    lines.push('')
    lines.push(`- ${match.path}`)
    lines.push(`  files: ${match.fileCount}`)
    lines.push(`  directories: ${match.directoryCount}`)
    lines.push(`  bytes: ${match.byteCount}`)
    if (match.deleted) lines.push('  deleted: true')
  }

  if (!value.deleted && value.matches.length > 0) {
    lines.push('')
    lines.push(`To delete, call again with dryRun=false and confirm="${value.confirmation}".`)
  }

  const text = lines.join('\n')
  return text.length <= DEFAULT_MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, DEFAULT_MAX_RESULT_CHARS)}\n...truncated...`
}

function currentAgentSessionId(exec) {
  const session = exec.agent?.session
  if (session === undefined || session === null) return undefined
  return typeof session.id === 'string' ? session.id : undefined
}

function registerTool(ctx, config) {
  try {
    // Use the registry's raw JSON Schema form so this local bundle does not
    // depend on an internal DSH package being resolvable from its linked folder.
    ctx.tools.register({
      name: 'dsh_delete_session_permanently',
      description: 'Permanently delete a DeepSeek Harness JSONL-backed session directory from disk. This is not archive. Use dryRun first; stop other Harness processes before deleting.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Exact DeepSeek Harness session id to permanently delete.',
          },
          root: {
            type: 'string',
            description: 'Absolute JSONL session root. If omitted, plugin config root, DSH_SESSION_ROOT, DSH_SESSIONS_ROOT, or $DSH_HOME/sessions is used.',
          },
          cwd: {
            type: 'string',
            description: 'Optional original project cwd to narrow the search to one project directory.',
          },
          dryRun: {
            type: 'boolean',
            description: 'When true or omitted, only reports matching directories and does not delete.',
          },
          confirm: {
            type: 'string',
            description: 'Required for deletion. Must equal PERMANENTLY DELETE <sessionId>.',
          },
          allowCurrentSession: {
            type: 'boolean',
            description: 'Set true only if deliberately deleting the session running this tool. Strongly discouraged.',
          },
          allowMultipleMatches: {
            type: 'boolean',
            description: 'Set true to delete more than one matching directory if duplicate ids exist under different project directories.',
          },
        },
        required: ['sessionId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      },
      async execute(args, exec) {
        const sessionId = args.sessionId.trim()
        const activeSessionId = currentAgentSessionId(exec)
        if (activeSessionId === sessionId && args.allowCurrentSession !== true) {
          throw new Error(
            'refusing to delete the currently running session; pass allowCurrentSession=true only if you have stopped using this session elsewhere',
          )
        }

        return permanentDeleteSession({
          root: resolveSessionRoot(args.root ?? config.root),
          sessionId,
          cwd: args.cwd,
          dryRun: args.dryRun ?? true,
          confirm: args.confirm,
          allowMultipleMatches: args.allowMultipleMatches === true,
          signal: exec.signal,
        })
      },
      presentCall: args => ({
        card: 'generic',
        title: args?.dryRun === false ? `Delete DSH session ${args?.sessionId ?? ''}` : `Inspect DSH session ${args?.sessionId ?? ''}`,
        kind: args?.dryRun === false ? 'delete' : 'read',
        rawInput: args,
      }),
    })
  } catch (error) {
    warn(`工具注册失败，已跳过（界面删除不受影响）：${String(error)}`)
  }
}

/* ───────────────────────── HTTP：给界面用的删除端点 ───────────────────────── */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

class HttpError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

/**
 * 读请求体。三条护栏：限长 8KB（超限先应答再断开）、上传超时 5s、任何路径只 resolve 一次。
 */
function readJson(request, response) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    let settled = false
    let timer = null

    const finish = result => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }
    const abort = (status, payload) => {
      try {
        if (!response.headersSent) {
          const text = JSON.stringify(payload)
          response.writeHead(status, { ...JSON_HEADERS, Connection: 'close' })
          response.end(text)
        }
      } catch {
        /* 连接可能已断 */
      }
      try {
        request.destroy()
      } catch {
        /* 已经断了 */
      }
    }

    timer = setTimeout(() => {
      abort(408, { ok: false, error: 'request-timeout' })
      finish({ ok: false, error: 'request-timeout' })
    }, BODY_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        abort(413, { ok: false, error: 'body-too-large' })
        finish({ ok: false, error: 'body-too-large' })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return finish({ ok: true, value: null })
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false, error: 'invalid-body' })
      }
    })
    request.on('error', () => finish({ ok: false, error: 'invalid-body' }))
    request.on('close', () => {
      if (!settled) finish({ ok: false, error: 'invalid-body' })
    })
  })
}

function deleteTimeoutSignal() {
  try {
    return AbortSignal.timeout(DELETE_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/**
 * 广播「这个会话已经没了」，让所有已连接的前端把该行从左侧列表里摘掉。
 *
 * 这不是我们自己发明的私有事件：`api-session/removed` 是宿主自己用的事件名 ——
 * `dsh-api-session-controller` 在会话被销毁时 emit 它，`dsh-api-remotes` 把它列在
 * 转发白名单里（{ event: "api-session/removed", mode: "emit" }），会话控制器的客户端
 * 那一半则用
 *   ctx.remote.$on('api-session/removed', id => sessions.handleSessionRemoved(id))
 * 订阅它，而 handleSessionRemoved 会记一条 { kind: 'remove' } 变更、把它从列表快照里
 * 过滤掉并通知订阅者 —— 也就是官方「会话没了，列表掉行」的那条通路。我们删完磁盘后
 * 复用它，列表当场刷新，不需要用户切换会话或重启。
 *
 * 两个约束（都来自网关实现，别踩）：
 *  - 参数必须是可无损 JSON 化的值，网关会逐个校验，所以只传一个字符串 id；
 *  - cordis 的 emit 在没有 thisArg 时不过滤任何监听器，所以在插件自己的 ctx 上 emit
 *    也能到达注册在根上的转发器，不需要拿 root。
 */
function broadcastSessionRemoved(ctx, sessionId) {
  try {
    if (ctx && typeof ctx.emit === 'function') {
      ctx.emit('api-session/removed', sessionId)
      return true
    }
  } catch (error) {
    warn(`广播会话移除事件失败（列表可能不会自动刷新）：${String(error)}`)
  }
  return false
}

async function handleSessionPost(body, config) {
  const payload = body && typeof body === 'object' ? body : null
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  if (sessionId === '') throw new HttpError(400, 'sessionId is required')

  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() !== '' ? payload.cwd.trim() : undefined
  const confirmation = confirmationText(sessionId)
  const confirm = typeof payload.confirm === 'string' ? payload.confirm : undefined
  if (confirm !== undefined && confirm !== confirmation) {
    throw new HttpError(400, `confirmation mismatch; expected "${confirmation}"`)
  }
  if (payload.confirm !== undefined && typeof payload.confirm !== 'string') {
    throw new HttpError(400, 'confirm must be a string')
  }

  const result = await permanentDeleteSession({
    root: resolveSessionRoot(config.root),
    sessionId,
    cwd,
    dryRun: confirm === undefined,
    confirm,
    allowMultipleMatches: payload.allowMultipleMatches === true,
    signal: deleteTimeoutSignal(),
  })

  return { ok: true, ...result }
}

function registerSessionEndpoint(ctx, config) {
  const route = {
    kind: 'exact',
    path: ENDPOINT,
    handler: async (request, response) => {
      try {
        if (request.method === 'GET') {
          response.writeHead(200, JSON_HEADERS)
          response.end(JSON.stringify({
            ok: true,
            package: PACKAGE_ID,
            root: resolveSessionRoot(config.root),
          }))
          return
        }

        if (request.method !== 'POST') {
          response.writeHead(405, { ...JSON_HEADERS, Allow: 'GET, POST' })
          response.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
          return
        }

        const body = await readJson(request, response)
        if (!body.ok) {
          if (!response.headersSent) {
            response.writeHead(400, JSON_HEADERS)
            response.end(JSON.stringify({ ok: false, error: body.error ?? 'invalid-body' }))
          }
          return
        }

        const value = await handleSessionPost(body.value, config)
        if (value.deleted) {
          info(`界面删除完成：${value.sessionId}（${value.matches.length} 个目录）`)
          // 磁盘删完就通知前端掉行：这是"删除后直接刷新"的那一半。
          value.removed = broadcastSessionRemoved(ctx, value.sessionId)
        }
        response.writeHead(200, JSON_HEADERS)
        response.end(JSON.stringify(value))
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        const code = error instanceof HttpError ? error.code : 'internal'
        if (status >= 500) warn(`删除端点异常：${String(error)}`)
        try {
          if (!response.headersSent) {
            response.writeHead(status, JSON_HEADERS)
            response.end(JSON.stringify({ ok: false, error: code }))
          }
        } catch {
          /* 连接可能已断 */
        }
      }
    },
  }

  ctx.effect(() => {
    let dispose = null
    try {
      dispose = ctx.webServer.register(route)
      info(`界面删除端点已就绪：${ENDPOINT}`)
    } catch (error) {
      warn(`删除端点注册失败（菜单项仍能显示，但删除会报错）：${String(error)}`)
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 卸载异常不冒泡 */
      }
    }
  }, `${PACKAGE_ID}: session endpoint`)
}

export function apply(ctx, config = {}) {
  logger = loggerFor(ctx)
  registerTool(ctx, config)
  try {
    registerSessionEndpoint(ctx, config)
  } catch (error) {
    // 端点挂掉绝不能牵连工具的注册结果
    warn(`删除端点初始化失败，已跳过：${String(error)}`)
  }
}
