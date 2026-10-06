import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { test } from 'node:test'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** 按真实 loader 的约定物化产物：factory(require) 的返回值就是模块 exports。 */
function materialize(requireImpl, fetchImpl) {
  const registrations = []
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    window: { __ModuleLoader__: { load: registration => registrations.push(registration) } },
    fetch:
      fetchImpl ??
      function () {
        throw new Error('fetch 未打桩')
      },
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  new vm.Script(readFileSync(BUNDLE, 'utf8'), { filename: 'lib/client.js' }).runInContext(context)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-permanent-delete')
  return { exports: registrations[0].factory(requireImpl), sandbox }
}

function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, get) => get(),
  }
}

function stubPrimitives() {
  return {
    MenuItemButton: 'MenuItemButton',
    Modal: 'Modal',
    Button: 'Button',
    IconTrashOutlineRegular: 'IconTrashOutlineRegular',
  }
}

/** 深度遍历 createElement 产物，找第一个命中的元素。 */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    const hit = Array.isArray(child) ? find({ children: child }, predicate) : find(child, predicate)
    if (hit) return hit
  }
  return undefined
}

/** createElement 的 children 是数组，取第一项当"这个元素的文案"。 */
function label(node) {
  return Array.isArray(node.children) ? node.children[0] : node.children
}

/** fakeCtx(sessionsService)：sessionsService 传 null 表示前端没有会话服务。 */
function fakeCtx(sessionsService) {
  const registered = []
  const sessionCalls = []
  const service =
    sessionsService === undefined
      ? {
          handleSessionRemoved: id => sessionCalls.push(['handleSessionRemoved', id]),
          refresh: () => sessionCalls.push(['refresh']),
        }
      : sessionsService
  return {
    registered,
    sessionCalls,
    get(name) {
      return name === 'sessions' ? service : undefined
    },
    slots: {
      inject(name, factoryFn) {
        factoryFn()
        return () => {}
      },
      register(options, component) {
        registered.push({ name: options.name, id: options.id, order: options.order, component })
        return () => {}
      },
    },
  }
}

test('client bundle registers the session menu item and the confirm overlay', () => {
  const { exports } = materialize(spec => {
    if (spec === 'react') return stubReact()
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives()
    throw new Error(`unexpected require: ${spec}`)
  })

  assert.deepEqual(Array.from(exports.inject), ['slots'])
  assert.equal(typeof exports.apply, 'function')

  const ctx = fakeCtx()
  exports.apply(ctx)

  const names = ctx.registered.map(row => row.name).sort()
  assert.deepEqual(names, ['shell.overlay', 'sidebar.workspaces.session.menu.item'])

  const menu = ctx.registered.find(row => row.name === 'sidebar.workspaces.session.menu.item')
  assert.equal(menu.id, 'dsh-permanent-delete')
  assert.equal(menu.order, 500)
  assert.equal(typeof menu.component, 'function')

  const overlay = ctx.registered.find(row => row.name === 'shell.overlay')
  assert.equal(overlay.id, 'dsh-permanent-delete.confirm')
})

test('menu row opens the confirm dialog, dry-runs, then deletes on confirm', async () => {
  const calls = []
  const responses = [
    { ok: true, root: 'C:\\root', sessionId: 'session-1', deleted: false, matches: [{ path: 'C:\\root\\p\\session-1', fileCount: 3, directoryCount: 1, byteCount: 2048, deleted: false }] },
    { ok: true, root: 'C:\\root', sessionId: 'session-1', deleted: true, matches: [{ path: 'C:\\root\\p\\session-1', fileCount: 3, directoryCount: 1, byteCount: 2048, deleted: true }] },
  ]
  const { exports } = materialize(
    spec => {
      if (spec === 'react') return stubReact()
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives()
      throw new Error(`unexpected require: ${spec}`)
    },
    (_url, options) => {
      calls.push(JSON.parse(options.body))
      const body = responses.shift()
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) })
    },
  )

  const ctx = fakeCtx()
  exports.apply(ctx)
  const menuComponent = ctx.registered.find(row => row.name === 'sidebar.workspaces.session.menu.item').component
  const overlayComponent = ctx.registered.find(row => row.name === 'shell.overlay').component

  // 弹窗未打开时什么都不渲染
  assert.equal(overlayComponent(), null)

  // 菜单行渲染出来，并带 onSelect
  let menuClosed = false
  const row = menuComponent({
    sessionId: 'session-1',
    displayTitle: '我的会话',
    useMenuOpenState: () => [false, value => { menuClosed = value === false }],
  })
  assert.equal(row.type, 'MenuItemButton')
  assert.equal(label(row), '删除会话')

  // 点击：先关菜单，再 dry run
  row.props.onSelect()
  assert.equal(menuClosed, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { sessionId: 'session-1' })
  await new Promise(resolve => setTimeout(resolve, 0))

  // 弹窗出现，标题/描述正确，且能看到将要删除什么
  const dialog = overlayComponent()
  assert.equal(dialog.type, 'Modal')
  assert.equal(dialog.props.title, '删除会话')
  assert.equal(dialog.props.description, '我的会话')
  assert.ok(JSON.stringify(dialog).includes('2.0 KB'))

  // 点「永久删除」：必须带上完全一致的确认识别串（按钮在 Modal 的 footer prop 里）
  const deleteButton = find(dialog.props.footer, node => label(node) === '永久删除')
  assert.ok(deleteButton, '弹窗里找不到「永久删除」按钮')
  deleteButton.props.onClick()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], { sessionId: 'session-1', confirm: 'PERMANENTLY DELETE session-1' })
  await new Promise(resolve => setTimeout(resolve, 0))

  const done = overlayComponent()
  assert.ok(JSON.stringify(done).includes('已从磁盘永久删除，左侧列表已刷新'))

  // 删除成功后必须当场把该行从左侧列表里摘掉
  assert.deepEqual(ctx.sessionCalls, [['handleSessionRemoved', 'session-1']])

  // 关闭后弹窗再次返回 null
  const closeButton = find(done.props.footer, node => label(node) === '关闭')
  closeButton.props.onClick()
  assert.equal(overlayComponent(), null)
})

/** require 打桩：React + UI primitives。 */
function requireImpl(spec) {
  if (spec === 'react') return stubReact()
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives()
  throw new Error(`unexpected require: ${spec}`)
}

function deleteResponses() {
  return [
    { ok: true, root: 'C:\\root', sessionId: 'session-1', deleted: false, matches: [{ path: 'C:\\root\\p\\session-1', fileCount: 3, directoryCount: 1, byteCount: 2048, deleted: false }] },
    { ok: true, root: 'C:\\root', sessionId: 'session-1', deleted: true, matches: [{ path: 'C:\\root\\p\\session-1', fileCount: 3, directoryCount: 1, byteCount: 2048, deleted: true }] },
  ]
}

/** 按调用顺序应答：第一次是 dry run，第二次是确认删除。 */
function fetchStub() {
  const queue = deleteResponses()
  return (_url, options) => {
    const body = queue.shift()
    void JSON.parse(options.body)
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) })
  }
}

/** 走一遍完整流程：点菜单行 → dry run → 点「永久删除」，返回终态弹窗。 */
async function runDelete(ctx, exports) {
  exports.apply(ctx)
  const menuComponent = ctx.registered.find(row => row.name === 'sidebar.workspaces.session.menu.item').component
  const overlayComponent = ctx.registered.find(row => row.name === 'shell.overlay').component
  menuComponent({ sessionId: 'session-1', displayTitle: 'x', useMenuOpenState: () => [false, () => {}] }).props.onSelect()
  await new Promise(resolve => setTimeout(resolve, 0))
  find(overlayComponent().props.footer, node => label(node) === '永久删除').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  return overlayComponent()
}

test('delete falls back to a full list refresh when the removal API is missing', async () => {
  const refreshed = []
  const ctx = fakeCtx({ refresh: () => refreshed.push('refresh') })
  const { exports } = materialize(requireImpl, fetchStub())
  const done = await runDelete(ctx, exports)
  assert.deepEqual(refreshed, ['refresh'])
  assert.ok(JSON.stringify(done).includes('已从磁盘永久删除，左侧列表已刷新'))
})

test('delete still reports success when the sessions service is unavailable', async () => {
  const ctx = fakeCtx(null)
  const { exports } = materialize(requireImpl, fetchStub())
  const done = await runDelete(ctx, exports)
  assert.deepEqual(ctx.sessionCalls, [])
  assert.ok(JSON.stringify(done).includes('已从磁盘永久删除'))
  assert.ok(JSON.stringify(done).includes('切换一次会话即可刷新'))
})

test('menu row survives missing UI primitives', () => {
  const { exports } = materialize(spec => {
    if (spec === 'react') return stubReact()
    throw new Error(`primitives 不可用：${spec}`)
  })
  const ctx = fakeCtx()
  exports.apply(ctx)
  const menuComponent = ctx.registered.find(row => row.name === 'sidebar.workspaces.session.menu.item').component
  const row = menuComponent({ sessionId: 'session-1', displayTitle: 'x' })
  assert.equal(row.type, 'button')
  assert.equal(label(row), '删除会话')
})
