/* 由 build.mjs 生成，请勿直接编辑；改 client.js 后重新 node build.mjs。 */
window.__ModuleLoader__.load({
  id: "dsh-permanent-delete",
  factory: function (require) {
    var module = { exports: {} };
    var __esRequire = require;
/**
 * dsh-permanent-delete —— 浏览器半边（源码；由 build.mjs 包成 lib/client.js）
 *
 * 目标：左侧会话列表里每行的「⋯」菜单最下方多一条「删除会话」，点开后是确认弹窗，
 * 确认即调用宿主端点 /plugins/dsh-permanent-delete/session 永久删除该会话目录。
 *
 * 三条纪律（都是从 effort-slider 的现场事故里学来的）：
 *  1. **apply 里绝不抛**：这里抛错会让整个 entry 加载失败，界面上就什么都没有了；
 *  2. **依赖取不到就降级**：React / UI primitives 都可能拿不到，拿不到就用原生元素，
 *     绝不因为"没有漂亮控件"就让功能消失；
 *  3. **状态放模块级**：菜单项与确认弹窗是两个独立的插槽条目，靠模块级可观察状态共享
 *     （弹窗挂在 shell.overlay，菜单一关菜单项就卸载了，所以弹窗不能渲染在菜单项里）。
 */
(function () {
  var PACKAGE_ID = 'dsh-permanent-delete'
  var MENU_SLOT = 'sidebar.workspaces.session.menu.item'
  var OVERLAY_SLOT = 'shell.overlay'
  var ENDPOINT = '/plugins/dsh-permanent-delete/session'

  /* ───────────────── 运行时依赖：取不到就降级，绝不抛 ───────────────── */

  function resolveReact(require) {
    try {
      if (typeof require === 'function') {
        var mod = require('react')
        var candidate = mod && (mod.default && mod.default.createElement ? mod.default : mod)
        if (candidate && typeof candidate.createElement === 'function') return candidate
      }
    } catch (error) {
      console.warn('[' + PACKAGE_ID + "] require('react') 失败：" + String(error))
    }
    try {
      if (typeof window !== 'undefined' && window.React && typeof window.React.createElement === 'function') {
        return window.React
      }
    } catch (error) {
      /* 忽略 */
    }
    return null
  }

  /** UI 原子组件（Menu/Modal/Button/图标）；拿不到就走原生元素兜底。 */
  function resolvePrimitives(require) {
    try {
      if (typeof require === 'function') {
        var mod = require('@deepseek-ai/dsh-client-ui-primitives')
        if (mod && typeof mod === 'object') return mod
      }
    } catch (error) {
      console.warn('[' + PACKAGE_ID + '] UI primitives 不可用，改用原生元素：' + String(error))
    }
    return null
  }

  /* ───────────────── 删除请求状态（菜单项与弹窗共享） ───────────────── */

  var current = null // null | { sessionId, displayTitle, phase, error, result }
  var listeners = []

  function getSnapshot() {
    return current
  }

  function subscribe(listener) {
    listeners.push(listener)
    return function unsubscribe() {
      var index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    }
  }

  function notify() {
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i]()
      } catch (error) {
        /* 一个订阅者出错不影响其它订阅者 */
      }
    }
  }

  function patch(next) {
    current = current === null ? next : Object.assign({}, current, next)
    notify()
  }

  function close() {
    current = null
    notify()
  }

  /* ───────────────── 与宿主端点通信 ───────────────── */

  function post(payload) {
    try {
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (response) {
        return response.text().then(function (text) {
          var body = null
          try {
            body = JSON.parse(text)
          } catch (error) {
            /* 非 JSON（比如 404 页面） */
          }
          if (!response.ok) {
            return { ok: false, error: (body && body.error) || 'HTTP ' + response.status }
          }
          return body && typeof body === 'object' ? body : { ok: false, error: 'empty-response' }
        })
      }).catch(function (error) {
        return { ok: false, error: String((error && error.message) || error) }
      })
    } catch (error) {
      return Promise.resolve({ ok: false, error: String((error && error.message) || error) })
    }
  }

  /** 打开弹窗并先做一次 dry run，把"将要删掉什么"摆在用户面前。 */
  function inspect(sessionId, displayTitle) {
    patch({ sessionId: sessionId, displayTitle: displayTitle, phase: 'inspecting', error: null, result: null })
    post({ sessionId: sessionId }).then(function (body) {
      if (!getSnapshot()) return // 已经关掉了
      if (!body || body.ok !== true) {
        patch({ phase: 'error', error: (body && body.error) || '读取会话信息失败' })
        return
      }
      patch({ phase: 'confirm', result: body })
    })
  }

  function confirmDelete() {
    var target = getSnapshot()
    if (!target) return
    patch({ phase: 'deleting', error: null, refreshed: null })
    post({ sessionId: target.sessionId, confirm: 'PERMANENTLY DELETE ' + target.sessionId }).then(function (body) {
      if (!getSnapshot()) return
      if (!body || body.ok !== true) {
        patch({ phase: 'error', error: (body && body.error) || '删除失败' })
        return
      }
      // 磁盘已经删掉了：让左侧列表当场少这一行
      patch({ phase: 'done', result: body, refreshed: forgetSession(target.sessionId) })
    })
  }

  /* ───────────────── 删除后刷新左侧列表 ───────────────── */

  /**
   * 宿主 ctx。apply 里存下来：菜单项和弹窗是两个独立插槽，只有这里能拿到根上下文，
   * 而"删完把这一行摘掉"要用到前端的 sessions 服务。
   */
  var hostCtx = null

  /**
   * 取前端的会话服务（@deepseek-ai/dsh-api-session-controller 注册在根上的 `sessions`）。
   * 拿不到就返回 null —— 我们还有宿主广播的 api-session/removed 兜底，绝不因为
   * 这里取不到就让删除流程失败。
   */
  function resolveSessions(ctx) {
    try {
      if (ctx && typeof ctx.get === 'function') {
        var service = ctx.get('sessions')
        if (service && typeof service === 'object') return service
      }
    } catch (error) {
      /* 服务还没装好：走兜底 */
    }
    try {
      var direct = ctx ? ctx.sessions : null
      if (direct && typeof direct === 'object') return direct
    } catch (error) {
      /* 同上 */
    }
    return null
  }

  /**
   * 删完立刻让左侧列表少这一行。
   *
   * 首选 handleSessionRemoved(sessionId)：它就是宿主广播 api-session/removed 时前端
   * 调用的那个方法，记一条 remove 变更、把该行从快照里过滤掉并通知订阅者，当场生效，
   * 而且不会把当前打开着的会话重新拉回来（整表 refresh 做不到这一点）。
   * 只有在这个方法不存在时才退而用 refresh() 整表重拉。
   *
   * @returns 'removed' | 'refreshed' | null（null = 两条路都没有，交给宿主广播）
   */
  function forgetSession(sessionId) {
    var service = resolveSessions(hostCtx)
    if (!service) return null
    try {
      if (typeof service.handleSessionRemoved === 'function') {
        service.handleSessionRemoved(sessionId)
        return 'removed'
      }
    } catch (error) {
      console.warn('[' + PACKAGE_ID + '] 从列表移除该会话失败：' + String(error))
    }
    try {
      if (typeof service.refresh === 'function') {
        service.refresh()
        return 'refreshed'
      }
    } catch (error) {
      console.warn('[' + PACKAGE_ID + '] 刷新会话列表失败：' + String(error))
    }
    return null
  }

  /* ───────────────── 展示用小工具 ───────────────── */

  function formatBytes(bytes) {
    var value = Number(bytes)
    if (!isFinite(value) || value < 0) return '—'
    if (value < 1024) return value + ' B'
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
    return (value / 1024 / 1024).toFixed(1) + ' MB'
  }

  function summaryLines(result) {
    var matches = (result && result.matches) || []
    var lines = []
    for (var i = 0; i < matches.length; i += 1) {
      var match = matches[i]
      lines.push(match.path + '（' + match.fileCount + ' 个文件，' + formatBytes(match.byteCount) + '）')
    }
    return lines
  }

  /* ───────────────── 组件 ───────────────── */

  function createPendingHook(React) {
    if (typeof React.useSyncExternalStore === 'function') {
      return function usePending() {
        return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      }
    }
    // React 18 以下：useState + useEffect 订阅
    return function usePending() {
      var pair = React.useState(getSnapshot())
      var setLocal = pair[1]
      React.useEffect(function () {
        return subscribe(function () {
          setLocal(getSnapshot())
        })
      }, [])
      return pair[0]
    }
  }

  var FALLBACK_ROW_STYLE = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '6px 10px',
    border: '0',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  }

  var FALLBACK_OVERLAY_STYLE = {
    position: 'fixed',
    inset: '0',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.45)',
  }

  var FALLBACK_CARD_STYLE = {
    minWidth: '320px',
    maxWidth: '520px',
    padding: '20px',
    borderRadius: '12px',
    background: 'var(--dsw-alias-bg-elevated, #fff)',
    color: 'var(--dsw-alias-fg-primary, #1a1a1a)',
    boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
  }

  var DANGER_STYLE = { color: '#e5484d' }

  /** 菜单行：order 500，排在 置顶/重命名/分叉/归档 之后。 */
  function createMenuItem(React, primitives) {
    var h = React.createElement
    return function DeleteSessionMenuItem(props) {
      var sessionId = props ? props.sessionId : undefined
      var displayTitle = props && props.displayTitle ? props.displayTitle : ''
      var useMenuOpenState = props ? props.useMenuOpenState : undefined

      var onSelect = function () {
        // 先关菜单：菜单一关菜单项就卸载，弹窗由 shell.overlay 那份继续活着
        try {
          if (typeof useMenuOpenState === 'function') {
            var pair = useMenuOpenState()
            if (pair && typeof pair[1] === 'function') pair[1](false)
          }
        } catch (error) {
          /* 关不掉也照样继续 */
        }
        if (typeof sessionId !== 'string' || sessionId === '') return
        inspect(sessionId, displayTitle)
      }

      var icon = primitives && primitives.IconTrashOutlineRegular
        ? h(primitives.IconTrashOutlineRegular, { size: 14 })
        : null

      if (primitives && primitives.MenuItemButton) {
        return h(primitives.MenuItemButton, { onSelect: onSelect, icon: icon, separatorBefore: true }, '删除会话')
      }
      return h('button', { type: 'button', onClick: onSelect, style: FALLBACK_ROW_STYLE }, '删除会话')
    }
  }

  /** 确认弹窗：shell.overlay 条目，读同一份模块级状态。 */
  function createDialog(React, primitives, usePending) {
    var h = React.createElement
    return function DeleteSessionDialog() {
      var pending = usePending()
      if (!pending) return null

      var busy = pending.phase === 'inspecting' || pending.phase === 'deleting'
      var lines = summaryLines(pending.result)

      var body = []
      if (pending.phase === 'inspecting') {
        body.push(h('p', { key: 'p1' }, '正在读取会话目录…'))
      } else if (pending.phase === 'deleting') {
        body.push(h('p', { key: 'p1' }, '正在永久删除…'))
      } else if (pending.phase === 'error') {
        body.push(h('p', { key: 'p1', style: DANGER_STYLE }, '删除未完成：' + String(pending.error || '未知错误')))
      } else if (pending.phase === 'done') {
        body.push(h('p', { key: 'p1' }, '已从磁盘永久删除，左侧列表已刷新。'))
        if (lines.length > 0) {
          body.push(h('ul', { key: 'ul' }, lines.map(function (line, index) {
            return h('li', { key: String(index) }, line)
          })))
        }
        if (pending.refreshed === null) {
          // 两条本地通路都没走通；宿主广播的移除事件通常仍会到达，这里只说明另一种可能。
          body.push(h('p', { key: 'p2' }, '若左侧列表仍显示该项，切换一次会话即可刷新。'))
        }
      } else {
        body.push(h('p', { key: 'p1' }, '此操作会直接删除磁盘上的会话目录，不归档、不可恢复。'))
        if (lines.length === 0) {
          body.push(h('p', { key: 'p2' }, '未在会话根目录下找到匹配目录。'))
        } else {
          body.push(h('ul', { key: 'ul' }, lines.map(function (line, index) {
            return h('li', { key: String(index) }, line)
          })))
        }
      }

      var cancelLabel = pending.phase === 'done' ? '关闭' : '取消'
      var footerButtons = []
      if (pending.phase === 'confirm') {
        footerButtons.push(h('button', {
          key: 'delete',
          type: 'button',
          disabled: busy,
          onClick: confirmDelete,
          style: DANGER_STYLE,
        }, '永久删除'))
      }
      footerButtons.push(h('button', {
        key: 'cancel',
        type: 'button',
        disabled: busy,
        onClick: close,
      }, cancelLabel))

      var Button = primitives && primitives.Button
      var Modal = primitives && primitives.Modal
      var footer = []
      if (Button) {
        if (pending.phase === 'confirm') {
          footer.push(h(Button, {
            key: 'delete',
            variant: 'outline',
            disabled: busy,
            onClick: confirmDelete,
            style: DANGER_STYLE,
          }, '永久删除'))
        }
        footer.push(h(Button, {
          key: 'cancel',
          variant: 'outline',
          disabled: busy,
          onClick: close,
        }, cancelLabel))
      } else {
        footer = footerButtons
      }

      if (Modal) {
        return h(Modal, {
          open: true,
          onClose: busy ? function () {} : close,
          closeLabel: cancelLabel,
          title: '删除会话',
          description: pending.displayTitle || pending.sessionId,
          footer: h(React.Fragment, null, footer),
        }, h(React.Fragment, null, body))
      }

      return h('div', { style: FALLBACK_OVERLAY_STYLE },
        h('div', { style: FALLBACK_CARD_STYLE },
          h('h3', null, '删除会话'),
          h('div', null, body),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } }, footer)))
    }
  }

  /* ───────────────── 接入 ───────────────── */

  var inject = ['slots']

  function createApply(initialRequire) {
    return function apply(ctx) {
      hostCtx = ctx
      var React = resolveReact(initialRequire)
      if (!React) {
        console.error('[' + PACKAGE_ID + '] 拿不到 React 运行时，菜单项不会出现')
        return
      }
      var primitives = resolvePrimitives(initialRequire)
      var usePending = createPendingHook(React)
      var menuItem = createMenuItem(React, primitives)
      var dialog = createDialog(React, primitives, usePending)

      try {
        ctx.slots.inject(MENU_SLOT, function () {
          return ctx.slots.register({
            name: MENU_SLOT,
            id: 'dsh-permanent-delete',
            order: 500,
          }, menuItem)
        })
      } catch (error) {
        console.error('[' + PACKAGE_ID + '] 会话菜单项注册失败：', error)
      }

      try {
        ctx.slots.inject(OVERLAY_SLOT, function () {
          return ctx.slots.register({
            name: OVERLAY_SLOT,
            id: 'dsh-permanent-delete.confirm',
          }, dialog)
        })
      } catch (error) {
        console.error('[' + PACKAGE_ID + '] 确认弹窗注册失败：', error)
      }

      console.info('[' + PACKAGE_ID + '] 已挂载：会话菜单「删除会话」')
    }
  }

  var __initialRequire = typeof __esRequire === 'function' ? __esRequire : null
  module.exports = {
    apply: createApply(__initialRequire),
    inject: inject,
  }
})()

    if (module.exports && typeof module.exports.apply === 'function') return module.exports;
    throw new Error('dsh-permanent-delete: bundle 未设置导出（require 或模块体有问题）');
  },
});
