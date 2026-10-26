// ===========================================================================
// 70 — settings page and account bubble editor
// ===========================================================================
// `dsh-naiwa` previously shipped no settings UI at all and exposed only a single
// "today" number from the ledger. This module adds:
//
//   * a Settings page (registered into `settings.section`) covering every key in
//     the configuration file, with live save through PUT /dsh-naiwa/api/config.json
//   * the whale-style account bubble and its inline editor.
//
// The old floating accounting panel is intentionally gone: every accounting
// number now lives in the bubble, so there is only one surface to keep correct.

// ---------------------------------------------------------------------------
// Small DOM helpers (no framework: the pet engine is plain DOM too)
// ---------------------------------------------------------------------------

function uiEl(tag, className, text) {
  var el = document.createElement(tag)
  if (className) el.className = className
  if (text != null) el.textContent = String(text)
  return el
}

function uiMoney(value, currency) {
  var n = Number(value)
  if (!isFinite(n)) return '—'
  return (currency === 'USD' ? '$' : '¥') + n.toFixed(2)
}

/** Trust badge text for a `daySummary.source`. */
function uiSourceLabel(snapshot) {
  if (!snapshot) return ''
  if (snapshot.label) return String(snapshot.label)
  return String(snapshot.source || '')
}

// ---------------------------------------------------------------------------
// Account bubble — whale-widget's classic speech-bubble look
// ---------------------------------------------------------------------------
// The shape is the exact classic SVG used by dsh-whale-widget (1026 x 700
// viewBox: one large ellipse plus the two small tail bubbles). Keeping the same
// geometry means the silhouette, tail and 18-unit indigo stroke all match; the
// text layer sits inside the large ellipse rather than in a CSS rectangle.

/** Build the persistent account bubble once; `Group` fills it from the ledger. */
function buildAccountBubble() {
  var el = uiEl('div', CLS + '-abubble')
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', '奶蛙记账气泡')

  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 1026 700')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('aria-hidden', 'true')
  // Static, trusted geometry copied from dsh-whale-widget's classic bubble.
  svg.innerHTML =
    '<path fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" ' +
    'd="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '<ellipse cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>'
  el.appendChild(svg)

  var menu = uiEl('button', CLS + '-abubble-menu')
  menu.type = 'button'
  menu.title = '气泡菜单'
  menu.setAttribute('aria-label', '气泡菜单')
  for (var i = 0; i < 3; i += 1) menu.appendChild(uiEl('span'))
  el.appendChild(menu)

  var text = uiEl('div', CLS + '-abubble-text')
  var title = uiEl('div', CLS + '-abubble-title')
  var rows = uiEl('div', CLS + '-abubble-rows')

  function makeRow(label) {
    var row = uiEl('div', CLS + '-abubble-row')
    row.appendChild(uiEl('span', CLS + '-abubble-label', label))
    var value = uiEl('strong', CLS + '-abubble-value', '—')
    row.appendChild(value)
    rows.appendChild(row)
    return { row: row, label: row.firstChild, value: value }
  }

  var today = makeRow('今日已用')
  var balance = makeRow('全部余额')
  today.value.classList.add(CLS + '-abubble-value-today')
  balance.value.classList.add(CLS + '-abubble-value-balance')
  text.appendChild(title)
  text.appendChild(rows)
  el.appendChild(text)

  return {
    el: el,
    menu: menu,
    title: title,
    todayRow: today.row,
    todayLabel: today.label,
    todayValue: today.value,
    balanceRow: balance.row,
    balanceLabel: balance.label,
    balanceValue: balance.value,
  }
}

/**
 * Small editor opened by the bubble's ☰ menu. It edits the four labels and the
 * display toggles, previewing every keystroke on the live bubble. Saving goes to
 * localStorage (see `saveAccountBubblePrefs`), so no Host restart is required.
 */
function openAccountBubbleEditor(container, opts) {
  opts = opts || {}
  var panel = uiEl('div', CLS + '-bedit')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '编辑气泡')

  var head = uiEl('div', CLS + '-bedit-head')
  head.appendChild(uiEl('span', CLS + '-bedit-title', '编辑气泡'))
  var closeBtn = uiEl('button', CLS + '-bedit-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', '关闭')
  head.appendChild(closeBtn)
  panel.appendChild(head)

  var body = uiEl('div', CLS + '-bedit-body')
  var state = normalizeAccountBubble(opts.account || {}, defaultAccountBubble())

  function field(labelText, key, maxLength) {
    var row = uiEl('div', CLS + '-bedit-field')
    row.appendChild(uiEl('label', CLS + '-bedit-label', labelText))
    var input = uiEl('input', CLS + '-bedit-input')
    input.type = 'text'
    input.maxLength = maxLength
    input.value = state[key]
    input.addEventListener('input', function () { state[key] = input.value; preview() })
    row.appendChild(input)
    body.appendChild(row)
    return input
  }

  field('标题', 'title', 24)
  field('今日已用标签', 'todayLabel', 16)
  field('全部余额标签', 'balanceLabel', 16)

  function toggleRow(labelText, key) {
    var row = uiEl('label', CLS + '-bedit-check')
    var input = uiEl('input')
    input.type = 'checkbox'
    input.checked = state[key] === true
    input.addEventListener('change', function () { state[key] = input.checked; preview() })
    row.appendChild(input)
    row.appendChild(uiEl('span', null, labelText))
    body.appendChild(row)
    return input
  }
  toggleRow('显示标题', 'showTitle')
  toggleRow('显示今日已用', 'showToday')
  toggleRow('显示全部余额', 'showBalance')

  var orderRow = uiEl('div', CLS + '-bedit-field')
  orderRow.appendChild(uiEl('label', CLS + '-bedit-label', '上下顺序'))
  var order = uiEl('select', CLS + '-bedit-input')
  order.innerHTML = '<option value="today-first">今日已用 / 全部余额</option>' +
    '<option value="balance-first">全部余额 / 今日已用</option>'
  order.value = state.order
  order.addEventListener('change', function () { state.order = order.value; preview() })
  orderRow.appendChild(order)
  body.appendChild(orderRow)

  panel.appendChild(body)

  var foot = uiEl('div', CLS + '-bedit-foot')
  var status = uiEl('span', CLS + '-bedit-status')
  var resetBtn = uiEl('button', CLS + '-bedit-btn', '恢复默认')
  resetBtn.type = 'button'
  var cancelBtn = uiEl('button', CLS + '-bedit-btn', '取消')
  cancelBtn.type = 'button'
  var saveBtn = uiEl('button', CLS + '-bedit-btn ' + CLS + '-bedit-save', '保存')
  saveBtn.type = 'button'
  foot.appendChild(status)
  foot.appendChild(resetBtn)
  foot.appendChild(cancelBtn)
  foot.appendChild(saveBtn)
  panel.appendChild(foot)

  var closed = false
  function close() {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeydown, true)
    if (panel.parentNode) panel.parentNode.removeChild(panel)
    if (opts.onClose) opts.onClose()
  }
  function cancel() {
    if (opts.onCancel) opts.onCancel()
    close()
  }
  function onKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      cancel()
    }
  }
  function preview() {
    state = normalizeAccountBubble(state, defaultAccountBubble())
    if (opts.onPreview) opts.onPreview(state)
  }

  closeBtn.addEventListener('click', cancel)
  cancelBtn.addEventListener('click', cancel)
  resetBtn.addEventListener('click', function () {
    state = defaultAccountBubble()
    var inputs = body.querySelectorAll('input[type="text"]')
    inputs[0].value = state.title
    inputs[1].value = state.todayLabel
    inputs[2].value = state.balanceLabel
    var checks = body.querySelectorAll('input[type="checkbox"]')
    checks[0].checked = state.showTitle
    checks[1].checked = state.showToday
    checks[2].checked = state.showBalance
    order.value = state.order
    preview()
  })
  saveBtn.addEventListener('click', function () {
    status.textContent = '保存中…'
    var result
    try {
      result = opts.onSave ? opts.onSave(state) : false
    } catch (err) {
      status.textContent = '保存失败'
      return
    }
    if (result && typeof result.then === 'function') {
      result.then(function () { close() }, function () { status.textContent = '保存失败' })
      return
    }
    if (result === false) {
      status.textContent = '保存失败'
      return
    }
    close()
  })

  container.appendChild(panel)
  // Place it beside the bubble, never on top of the pet. If the bubble is near
  // the right edge the editor flips to its left; the same rule applies at the
  // top/bottom so it stays inside the overlay.
  var rect = container.getBoundingClientRect()
  var w = panel.offsetWidth
  var h = panel.offsetHeight
  var left = 16
  var top = 16
  if (opts.anchor && opts.anchor.getBoundingClientRect) {
    var ar = opts.anchor.getBoundingClientRect()
    left = ar.left - rect.left - w - 12
    if (left < 4 && ar.right - rect.left + 12 + w <= rect.width - 4) {
      left = ar.right - rect.left + 12
    }
    top = ar.top - rect.top
    left = clamp(left, 4, Math.max(4, rect.width - w - 4))
    top = clamp(top, 4, Math.max(4, rect.height - h - 4))
  } else {
    left = clamp(left, 4, Math.max(4, rect.width - w - 4))
    top = clamp(top, 4, Math.max(4, rect.height - h - 4))
  }
  panel.style.left = Math.round(left) + 'px'
  panel.style.top = Math.round(top) + 'px'
  panel.classList.add(CLS + '-bedit-in')
  document.addEventListener('keydown', onKeydown, true)
  return { el: panel, close: close }
}

// ---------------------------------------------------------------------------
// Settings page (registered into settings.section)
// ---------------------------------------------------------------------------

/**
 * Build the Settings section component.
 * @param {object} React the module-table React
 */
function createSettingsSection(React) {
  var h = React.createElement

  function Label(props) {
    return h('div', { className: CLS + '-set-label' }, props.children)
  }
  function Row(props) {
    return h('div', { className: CLS + '-set-row' }, props.children)
  }

  return function NaiwaSettings() {
    var state = React.useState(null)
    var cfg = state[0]
    var setCfg = state[1]
    var statusState = React.useState('')
    var status = statusState[0]
    var setStatus = statusState[1]
    var ledgerState = React.useState(null)
    var ledger = ledgerState[0]
    var setLedger = ledgerState[1]

    React.useEffect(function () {
      var alive = true
      fetch(API_BASE + '/config.json', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (b) {
          if (alive) setCfg(normalizeClientConfig(b && b.config))
        })
        .catch(function () {
          if (alive) setCfg(normalizeClientConfig(null))
        })
      fetch(API_BASE + '/ledger.json', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (s) { if (alive) setLedger(s) })
        .catch(function () { if (alive) setLedger({ ok: false, reason: 'network' }) })
      return function () { alive = false }
    }, [])

    if (!cfg) {
      return h('div', { className: CLS + '-set' }, h('div', { className: CLS + '-set-note' }, '读取配置中…'))
    }

    function patch(path, value) {
      var next = JSON.parse(JSON.stringify(cfg))
      var node = next
      for (var i = 0; i < path.length - 1; i += 1) node = node[path[i]]
      node[path[path.length - 1]] = value
      setCfg(next)
      setStatus('')
    }

    function save() {
      setStatus('保存中…')
      fetch(API_BASE + '/config.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg }),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b } }) })
        .then(function (res) {
          if (res.ok && res.body && res.body.ok) {
            setCfg(normalizeClientConfig(res.body.config))
            setStatus('已保存 · 刷新页面后奶蛙按新设置运行')
          } else {
            setStatus('保存失败：' + String((res.body && res.body.error) || 'unknown'))
          }
        })
        .catch(function (err) { setStatus('保存失败：' + String((err && err.message) || err)) })
    }

    function numInput(value, min, max, step, onChange) {
      return h('input', {
        className: CLS + '-set-input',
        type: 'number',
        value: value,
        min: min,
        max: max,
        step: step,
        onChange: function (ev) { onChange(Number(ev.target.value)) },
      })
    }

    function toggle(checked, onChange) {
      return h('input', {
        type: 'checkbox',
        checked: checked === true,
        onChange: function (ev) { onChange(ev.target.checked) },
      })
    }

    var children = []
    children.push(h('div', { className: CLS + '-set-head' }, '奶蛙桌宠'))

    // ---- 显示 ----
    children.push(h('div', { className: CLS + '-set-section' }, '显示'))
    children.push(h(Row, { key: 'enabled' },
      h(Label, null, '启用插件'),
      toggle(cfg.enabled, function (v) { patch(['enabled'], v) })))
    children.push(h(Row, { key: 'visible' },
      h(Label, null, '显示奶蛙'),
      toggle(cfg.pet.visible, function (v) { patch(['pet', 'visible'], v) })))
    children.push(h(Row, { key: 'scale' },
      h(Label, null, '大小档位'),
      h('div', { className: CLS + '-set-tiers' },
        TIERS.map(function (tier) {
          return h('button', {
            key: 'tier' + tier,
            type: 'button',
            className: CLS + '-set-tier' +
              (Math.abs(snapScale(cfg.pet.scale) - tier) < 1e-9 ? ' ' + CLS + '-set-tier-on' : ''),
            onClick: function () { patch(['pet', 'scale'], tier) },
          }, tierOf(tier) + '档 ' + tier.toFixed(1))
        }))))
    children.push(h(Row, { key: 'position' },
      h(Label, null, '初始位置'),
      h('select', {
        className: CLS + '-set-input',
        value: cfg.pet.startPosition,
        onChange: function (ev) { patch(['pet', 'startPosition'], ev.target.value) },
      },
        h('option', { value: 'bottom-right' }, '右下'),
        h('option', { value: 'bottom-left' }, '左下'),
        h('option', { value: 'bottom-center' }, '底部居中'),
        h('option', { value: 'random' }, '随机'))))
    children.push(h(Row, { key: 'maxPets' },
      h(Label, null, '分身上限'),
      numInput(cfg.pet.maxPets, 1, 40, 1, function (v) { patch(['pet', 'maxPets'], v) })))
    children.push(h(Row, { key: 'eye' },
      h(Label, null, '眼神跟随'),
      toggle(cfg.pet.eyeFollow, function (v) { patch(['pet', 'eyeFollow'], v) })))
    children.push(h(Row, { key: 'pause' },
      h(Label, null, '切到后台时暂停'),
      toggle(cfg.pet.pauseWhenHidden, function (v) { patch(['pet', 'pauseWhenHidden'], v) })))

    // ---- 音效 ----
    children.push(h('div', { className: CLS + '-set-section' }, '音效'))
    children.push(h(Row, { key: 'sound' },
      h(Label, null, '启用音效'),
      toggle(cfg.pet.sound, function (v) { patch(['pet', 'sound'], v) })))
    children.push(h(Row, { key: 'volume' },
      h(Label, null, '音量'),
      h('input', {
        className: CLS + '-set-range',
        type: 'range', min: 0, max: 1, step: 0.05,
        value: cfg.pet.volume,
        onChange: function (ev) { patch(['pet', 'volume'], Number(ev.target.value)) },
      })))

    // ---- 气泡 ----
    children.push(h('div', { className: CLS + '-set-section' }, '气泡'))
    children.push(h(Row, { key: 'bubbleOn' },
      h(Label, null, '显示气泡'),
      toggle(cfg.bubble.enabled, function (v) { patch(['bubble', 'enabled'], v) })))
    children.push(h(Row, { key: 'bubbleMs' },
      h(Label, null, '显示时长 (ms)'),
      numInput(cfg.bubble.durationMs, 800, 60000, 200, function (v) { patch(['bubble', 'durationMs'], v) })))
    children.push(h(Row, { key: 'bubbleW' },
      h(Label, null, '最大宽度 (px)'),
      numInput(cfg.bubble.maxWidthPx, 120, 480, 10, function (v) { patch(['bubble', 'maxWidthPx'], v) })))
    children.push(h('div', { className: CLS + '-set-hint' },
      '单击奶蛙唤出“今日已用 / 全部余额”气泡，5 秒后自动收起；每轮对话结束也会用它报账。气泡右上角 ☰ 菜单包含分身、归一、大笑、大小和编辑气泡等功能。'))

    var LINE_LABELS = {
      idle: '待机', click: '点击', hold: '蓄力', drag: '拖动', land: '落地',
      laugh: '大笑', split: '分身', merge: '合体', reunify: '归一', limit: '上限',
    }
    var lineKeys = Object.keys(cfg.bubble.lines)
    children.push(h('div', { className: CLS + '-set-hint' },
      '每块文案一行一条，随机选一条显示。可用占位符：{amount} {today} {total7}'))
    children.push(h('div', { className: CLS + '-set-lines' },
      lineKeys.map(function (key) {
        return h('div', { key: 'line' + key, className: CLS + '-set-line' },
          h('div', { className: CLS + '-set-line-label' },
            LINE_LABELS[key] || key,
            h('code', { className: CLS + '-set-line-key' }, key)),
          h('textarea', {
            className: CLS + '-set-textarea',
            rows: 2,
            value: cfg.bubble.lines[key].join('\n'),
            onChange: function (ev) {
              var lines = String(ev.target.value).split('\n')
                .map(function (s) { return s.trim() })
                .filter(function (s) { return s.length })
              patch(['bubble', 'lines', key], lines.length ? lines : [''])
            },
          }))
      })))

    // ---- 记账 ----
    children.push(h('div', { className: CLS + '-set-section' }, '记账'))
    children.push(h(Row, { key: 'accOn' },
      h(Label, null, '读取小鲸鱼账本'),
      toggle(cfg.accounting.enabled, function (v) { patch(['accounting', 'enabled'], v) })))
    children.push(h(Row, { key: 'accPoll' },
      h(Label, null, '轮询间隔 (秒)'),
      numInput(cfg.accounting.pollSec, 5, 3600, 5, function (v) { patch(['accounting', 'pollSec'], v) })))
    children.push(h(Row, { key: 'accAnnounce' },
      h(Label, null, '有新记账时冒泡'),
      toggle(cfg.accounting.announce, function (v) { patch(['accounting', 'announce'], v) })))
    children.push(h(Row, { key: 'accClick' },
      h(Label, null, '点击时显示账单气泡'),
      toggle(cfg.accounting.showTodayOnClick, function (v) { patch(['accounting', 'showTodayOnClick'], v) })))

    // ---- 账本快照 ----
    children.push(h('div', { className: CLS + '-set-section' }, '账本快照'))
    if (ledger && ledger.ok) {
      children.push(h('div', { className: CLS + '-set-ledger' },
        h('div', null, '今日已用 ' + uiMoney(ledger.today && ledger.today.amount, ledger.currency) +
          ' · ' + uiSourceLabel(ledger.today)),
        h('div', null, '近 7 天 ' + uiMoney(ledger.total7, ledger.currency) +
          ' · ' + (ledger.eventCount || 0) + ' 条记录'),
        h('div', null, '账本文件 ' + String(ledger.file || '—').replace(/^.*[\\/]/, '')),
      ))
    } else if (ledger) {
      children.push(h('div', { className: CLS + '-set-note' },
        '账本当前不可用：' + String(ledger.reason || 'unknown') +
        '（需要 dsh-whale-widget 写入过账本）'))
    } else {
      children.push(h('div', { className: CLS + '-set-note' }, '读取中…'))
    }

    children.push(h('div', { className: CLS + '-set-actions' },
      h('button', { type: 'button', className: CLS + '-set-save', onClick: save }, '保存'),
      status ? h('span', { className: CLS + '-set-status' }, status) : null))

    return h('div', { className: CLS + '-set' }, children)
  }
}
