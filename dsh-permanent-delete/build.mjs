/**
 * 把 client.js 打进 lib/client.js —— 宿主端只 serve `lib/client.js`（官方 checklist：
 * "Rebuild the bundle before probing a live dsh web server — the registry serves
 * lib/client.js, not sources."）。改完 client.js 必须跑一次：
 *
 *   node build.mjs
 *
 * 产物形状（与 app.asar 里官方 bundle 同形）：
 *   · loader 的 materialize() 是 `registered.factory(this.makeRequire(edges))`，
 *     **不注入 module / exports**，所以工厂必须自己声明 `var module = { exports: {} }`；
 *   · `var __esRequire = require;` 必须出现在模块体之前，模块体靠它 require('react')；
 *   · 工厂返回值就是模块 exports。
 *
 * 落盘策略：全部断言在内存里跑完 → 写临时文件 → 复读校验 → 原子改名。
 * 任何一步失败都不覆盖已有产物。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = name => fileURLToPath(new URL(name, import.meta.url))
const PACKAGE_ID = 'dsh-permanent-delete'
const OUT_FILE = here('./lib/client.js')
const LIB_DIR = here('./lib/')

function assert(condition, label, detail) {
  if (!condition) {
    throw new Error(`[build] 断言失败：${label}${detail === undefined ? '' : `\n        ↳ ${detail}`}`)
  }
  return true
}

const sha = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const bytes = text => Buffer.byteLength(text, 'utf8')
const toLf = text => text.replace(/\r\n?/g, '\n')

/* ───────────────── 1. 读源码 ───────────────── */

const source = toLf(readFileSync(here('./client.js'), 'utf8'))
const sourceSha = sha(source)

/* ───────────────── 2. 源码前置断言 ───────────────── */

assert(source.includes('module.exports'), 'client.js 没有用 module.exports 导出（工厂返回值必须带 apply）')
assert(source.includes('createApply'), 'client.js 里找不到 createApply')
assert(/var\s+inject\s*=\s*\[[^\]]*['"]slots['"]/.test(source), 'inject 数组必须包含 "slots"，否则 ctx.slots 不会被 Cordis 等待')
assert(source.includes('sidebar.workspaces.session.menu.item'), 'client.js 没有注册会话菜单插槽')
assert(!/<\/script/i.test(source), 'client.js 含 </script>，会截断脚本标签')
assert(!/[\u2028\u2029]/.test(source), 'client.js 含 U+2028/U+2029，会破坏 JS 字符串字面量')

/* ───────────────── 3. 生成产物（纯内存） ───────────────── */

const artifact = [
  '/* 由 build.mjs 生成，请勿直接编辑；改 client.js 后重新 node build.mjs。 */',
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(PACKAGE_ID)},`,
  '  factory: function (require) {',
  '    var module = { exports: {} };',
  '    var __esRequire = require;',
  source,
  "    if (module.exports && typeof module.exports.apply === 'function') return module.exports;",
  `    throw new Error('${PACKAGE_ID}: bundle 未设置导出（require 或模块体有问题）');`,
  '  },',
  '});',
  '',
].join('\n')

assert(artifact.includes(`id: ${JSON.stringify(PACKAGE_ID)}`), '产物里 bundle id 与包名不一致')
assert(
  artifact.indexOf('var __esRequire = require;') < artifact.indexOf('var PACKAGE_ID'),
  '工厂的 var __esRequire = require; 必须出现在模块体之前（否则 require("react") 静默失效）',
)

/* ───────────────── 4. 产物级校验：真的解析、真的物化 ───────────────── */

new vm.Script(artifact, { filename: 'lib/client.js' }) // 语法错误在这里炸

/** 按真实 loader 约定执行：factory(require) 的返回值就是模块 exports。 */
function materialize(text, stubRequire) {
  const registrations = []
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    window: { __ModuleLoader__: { load: registration => registrations.push(registration) } },
    fetch: () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }),
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  new vm.Script(text, { filename: 'lib/client.js' }).runInContext(context)
  assert(registrations.length === 1, `产物应当只注册一个 bundle factory，实际 ${registrations.length}`)
  assert(registrations[0].id === PACKAGE_ID, '产物注册的 id 与包名不一致', String(registrations[0].id))
  const exports = registrations[0].factory(stubRequire)
  return { exports, require: stubRequire }
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, get) => get(),
}

const materialized = materialize(artifact, spec => {
  if (spec === 'react') return fakeReact
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      MenuItemButton: 'MenuItemButton',
      Modal: 'Modal',
      Button: 'Button',
      IconTrashOutlineRegular: 'IconTrashOutlineRegular',
    }
  }
  throw new Error(`构建期不应 require ${spec}`)
})

assert(materialized.exports !== null && typeof materialized.exports === 'object', '工厂没有返回 exports 对象')
assert(typeof materialized.exports.apply === 'function', 'exports.apply 不是函数')
assert(Array.isArray(materialized.exports.inject) && materialized.exports.inject.includes('slots'), 'exports.inject 不含 "slots"')

/* 负向校验：导出坏掉时工厂必须响亮抛错，不能退回静默空插件 */
{
  const anchor = 'apply: createApply(__initialRequire)'
  const at = artifact.indexOf(anchor)
  assert(at >= 0, '产物里找不到 apply: createApply(__initialRequire)')
  const broken = artifact.slice(0, at) + 'apply: 0' + artifact.slice(at + anchor.length)
  let message = ''
  try {
    materialize(broken, () => {
      throw new Error('no requires')
    })
  } catch (error) {
    message = String(error && error.message ? error.message : error)
  }
  assert(message.includes('bundle 未设置导出'), '导出坏掉时工厂没有响亮抛错', message || '（居然没有抛错）')
}

/* ───────────────── 5. 落盘 ───────────────── */

assert(
  sha(toLf(readFileSync(here('./client.js'), 'utf8'))) === sourceSha,
  '构建期间 client.js 被改动，本次产物作废、不落盘 —— 请重跑',
)

mkdirSync(LIB_DIR, { recursive: true })
const previous = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : null
let writeState
if (previous === artifact) {
  writeState = 'unchanged（内容一致，未写盘）'
} else {
  const tmpFile = `${OUT_FILE}.tmp-${process.pid}`
  try {
    writeFileSync(tmpFile, artifact, 'utf8')
    const reread = readFileSync(tmpFile, 'utf8')
    assert(reread === artifact, '临时文件复读与内存产物不一致')
    new vm.Script(reread, { filename: 'lib/client.js (tmp)' })
    renameSync(tmpFile, OUT_FILE)
  } catch (error) {
    if (existsSync(tmpFile)) rmSync(tmpFile, { force: true })
    throw new Error(`写入失败（已有产物未被改动）：${String(error && error.message ? error.message : error)}`)
  }
  writeState = `written ${bytes(artifact)} bytes（旧产物 ${previous === null ? 0 : bytes(previous)} bytes）`
}

console.log(`[build] ${PACKAGE_ID} -> lib/client.js`)
console.log(`  artifact   ${bytes(artifact)} bytes  sha256 ${sha(artifact)}`)
console.log(`  source     client.js ${sourceSha.slice(0, 16)}`)
console.log(`  export     apply: yes | inject: ${JSON.stringify(materialized.exports.inject)}`)
console.log(`  write      ${writeState}`)
