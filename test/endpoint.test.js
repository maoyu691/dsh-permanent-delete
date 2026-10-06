import assert from 'node:assert/strict'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply } from '../index.js'
import { encodeSegment, projectKey } from '../lib/path-format.js'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 搭一个最小宿主：tools + webServer + effect，把注册的路由收下来。 */
function fakeHost() {
  const routes = []
  const tools = []
  const emitted = []
  const ctx = {
    emit(name, ...args) {
      emitted.push([name, ...args])
    },
    tools: {
      register(tool) {
        tools.push(tool)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
  }
  return { ctx, routes, tools, emitted }
}

function fakeResponse() {
  return {
    headersSent: false,
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(text) {
      if (text !== undefined) this.body = text
    },
  }
}

function fakeRequest(method, payload) {
  const request = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')])
  request.method = method
  request.destroy = () => {}
  return request
}

async function call(route, method, payload) {
  const response = fakeResponse()
  await route.handler(fakeRequest(method, payload), response)
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null }
}

async function seedSession(root, cwd, sessionId) {
  const dir = join(root, projectKey(cwd), encodeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl'), '{"type":"session"}\n')
  return dir
}

test('apply registers the agent tool and the session endpoint', async () => {
  const { ctx, routes, tools } = fakeHost()
  apply(ctx, {})
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'dsh_delete_session_permanently')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/plugins/dsh-permanent-delete/session')
  assert.equal(routes[0].kind, 'exact')
})

test('GET reports the resolved session root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-endpoint-'))
  const { ctx, routes } = fakeHost()
  apply(ctx, { root })
  const { status, body } = await call(routes[0], 'GET')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.root, root)
})

test('POST without confirm is a dry run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-endpoint-'))
  const dir = await seedSession(root, 'E:\\repo', 'session-1')
  const { ctx, routes } = fakeHost()
  apply(ctx, { root })

  const { status, body } = await call(routes[0], 'POST', { sessionId: 'session-1' })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.deleted, false)
  assert.equal(body.matches.length, 1)
  assert.equal(await exists(dir), true)
})

test('POST with the exact confirmation deletes the session directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-endpoint-'))
  const dir = await seedSession(root, 'E:\\repo', 'session-1')
  const { ctx, routes } = fakeHost()
  apply(ctx, { root })

  const { status, body } = await call(routes[0], 'POST', {
    sessionId: 'session-1',
    confirm: 'PERMANENTLY DELETE session-1',
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.deleted, true)
  assert.equal(await exists(dir), false)
})

test('a confirmed delete broadcasts api-session/removed so the sidebar drops the row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-endpoint-'))
  await seedSession(root, 'E:\\repo', 'session-1')
  const { ctx, routes, emitted } = fakeHost()
  apply(ctx, { root })

  const { body } = await call(routes[0], 'POST', {
    sessionId: 'session-1',
    confirm: 'PERMANENTLY DELETE session-1',
  })
  assert.equal(body.removed, true)
  assert.deepEqual(emitted, [['api-session/removed', 'session-1']])
})

test('a dry run broadcasts nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-endpoint-'))
  await seedSession(root, 'E:\\repo', 'session-1')
  const { ctx, routes, emitted } = fakeHost()
  apply(ctx, { root })

  const { body } = await call(routes[0], 'POST', { sessionId: 'session-1' })
  assert.equal(body.deleted, false)
  assert.equal(body.removed, undefined)
  assert.deepEqual(emitted, [])
})

test('POST rejects a missing or wrong confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-endpoint-'))
  const dir = await seedSession(root, 'E:\\repo', 'session-1')
  const { ctx, routes } = fakeHost()
  apply(ctx, { root })

  const missing = await call(routes[0], 'POST', {})
  assert.equal(missing.status, 400)
  assert.equal(missing.body.ok, false)

  const wrong = await call(routes[0], 'POST', { sessionId: 'session-1', confirm: 'delete it' })
  assert.equal(wrong.status, 400)
  assert.equal(wrong.body.ok, false)
  assert.equal(await exists(dir), true)
})

test('unsupported methods answer 405', async () => {
  const { ctx, routes } = fakeHost()
  apply(ctx, {})
  const { status } = await call(routes[0], 'DELETE')
  assert.equal(status, 405)
})
