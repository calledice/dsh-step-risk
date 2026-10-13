// DSH 0.2.0-rc.2 loads client entries as classic scripts. React is provided by
// its module loader; this file deliberately requires no separate build step.
window.__ModuleLoader__.load({
  id: 'dsh-step-risk',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const TAB = 'dsh-step-risk/overview'
    const BORDER = 'var(--dsw-alias-border-l2, rgba(127,127,127,.25))'
    const MUTED = 'var(--dsw-alias-label-secondary, #777)'
    const CONTROL = {
      color: 'inherit', background: 'transparent', border: '1px solid ' + BORDER,
      borderRadius: 8, padding: '6px 9px', font: 'inherit', minWidth: 0,
    }

    function percent(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ? (value * 100).toFixed(1) + '%' : '—'
    }

    function time(value) {
      const date = new Date(value)
      return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—'
    }

    function list(value) {
      return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
    }

    function route(sessionId) {
      return '/api/dsh-step-risk/snapshot' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '')
    }

    function useSnapshot(sessionId, visible, refresh) {
      const [state, setState] = React.useState({ key: sessionId, data: null, loading: true, error: '' })
      React.useEffect(() => {
        if (!visible) return
        let active = true
        let timer
        const controller = new AbortController()
        setState(old => old.key === sessionId
          ? { ...old, loading: true, error: '' }
          : { key: sessionId, data: null, loading: true, error: '' })
        async function read() {
          try {
            const response = await fetch(route(sessionId), {
              method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
            })
            if (!response.ok) throw new Error('读取失败（HTTP ' + response.status + '）')
            const data = await response.json()
            if (!data || data.schemaVersion !== 1 || !Array.isArray(data.steps) || !Array.isArray(data.sessions)) {
              throw new Error('数据格式不兼容，请确认 Host 与客户端使用同一版插件。')
            }
            if (active) setState({ key: sessionId, data, loading: false, error: '' })
          } catch (error) {
            if (active && !controller.signal.aborted) {
              setState(old => ({ ...old, loading: false, error: error instanceof Error ? error.message : '无法读取 Step Risk 数据。' }))
            }
          } finally {
            // Schedule only after the read settles; slow requests cannot pile up.
            if (active) timer = setTimeout(read, 2000)
          }
        }
        read()
        return () => { active = false; controller.abort(); clearTimeout(timer) }
      }, [sessionId, visible, refresh])
      // A session change must not briefly paint the previous session's steps.
      return state.key === sessionId ? state : { data: null, loading: true, error: '' }
    }

    function StepCard({ row }) {
      const estimate = row.stepFailure || {}
      const factors = estimate.factors || {}
      const names = list(row.toolNames)
      const outcome = { success: '成功', error: '错误', unknown: '未知' }[row.outcome] || '未知'
      const operation = { action: '执行操作', read: '读取', verification: '验证', unknown: '未知' }[row.operation] || '未知'
      const reasons = list(estimate.reasons)
      const limitations = list(estimate.limitations)
      const evidence = list(row.evidenceCodes)
      return h('article', {
        style: { border: '1px solid ' + BORDER, borderRadius: 10, padding: 12, overflowWrap: 'anywhere' },
        'aria-label': 'Turn ' + row.turn + ' / Step ' + row.step,
      },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' } },
        h('strong', { style: { fontSize: 13 } }, 'Turn ', row.turn, ' / Step ', row.step),
        h('strong', { style: { fontSize: 22, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, percent(estimate.value))),
      h('div', { style: { color: MUTED, fontSize: 12, marginTop: 4 } },
        '实际结果：', outcome, ' · ', operation, ' · ', row.role || 'unknown'),
      h('div', { style: { marginTop: 8, fontSize: 12 } }, names.length ? names.join(' · ') : '无工具调用'),
      h('p', { style: { margin: '8px 0 0', fontSize: 13, lineHeight: 1.5 } }, estimate.summary || '暂无估计说明'),
      h('details', { style: { marginTop: 9, fontSize: 12 } },
        h('summary', { style: { cursor: 'pointer', color: MUTED } }, '估计依据与限制'),
        h('p', { style: { margin: '8px 0', lineHeight: 1.6 } },
          '出错 ', percent(factors.problem), ' × 出错后未修复 ', percent(factors.persistence),
          ' × 未修复后导致任务失败 ', percent(factors.impact)),
        reasons.length ? h('ul', { style: { paddingLeft: 18, margin: '8px 0' } },
          reasons.map((reason, i) => h('li', { key: i }, reason))) : null,
        evidence.length ? h('p', { style: { margin: '8px 0' } }, '观测信号：', evidence.join(', ')) : null,
        limitations.length ? h('ul', { style: { paddingLeft: 18, margin: '8px 0', color: MUTED } },
          limitations.map((limitation, i) => h('li', { key: i }, limitation))) : null,
        h('p', { style: { color: MUTED, margin: '8px 0 0', lineHeight: 1.6 } },
          '来源：本地规则 · 证据质量：', estimate.evidenceQuality || 'unknown',
          ' · ', estimate.modelVersion || 'unknown', h('br'),
          '完成时间：', time(row.observedAt), ' · 修订 ', row.revision ?? 0)))
    }

    function StepRiskPanel({ sessionId: boundSession, visible = true, global = false }) {
      const [selection, setSelection] = React.useState('')
      const [sort, setSort] = React.useState('time')
      const [refresh, setRefresh] = React.useState(0)
      const sessionId = global ? selection : boundSession
      const state = useSnapshot(sessionId || '', visible, refresh)
      const data = state.data
      const sessions = data ? data.sessions : []
      React.useEffect(() => {
        if (global && !selection && sessions.length) setSelection(sessions[0].sessionId)
      }, [global, selection, data])
      const rows = data && sessionId ? data.steps.slice() : []
      rows.sort(sort === 'risk'
        ? (a, b) => (b.stepFailure?.value ?? -1) - (a.stepFailure?.value ?? -1) || a.ordinal - b.ordinal
        : (a, b) => a.ordinal - b.ordinal)
      return h('section', {
        'aria-label': 'Step Risk',
        style: { color: 'inherit', fontFamily: 'inherit', fontSize: 13, padding: 16, boxSizing: 'border-box', width: '100%', height: '100%', overflowY: 'auto' },
      },
      h('header', null,
        h('h2', { style: { fontSize: 16, lineHeight: 1.5, margin: '0 0 8px' } }, '每步最终失败概率（模型估计）'),
        h('p', { style: { color: MUTED, fontSize: 12, lineHeight: 1.6, margin: 0 } },
          '每个已完成的 DSH 步骤分别估计其错误导致最终任务失败的概率。各步数值不相加；它们可能共享失败原因。'),
        h('p', { style: { color: MUTED, fontSize: 11, margin: '8px 0 12px', overflowWrap: 'anywhere' } },
          'experimental_uncalibrated · 本地规则 · 低证据质量')),
      global ? h('label', { style: { display: 'grid', gap: 6, marginBottom: 12 } },
        '会话',
        h('select', { 'aria-label': '选择会话', value: selection, style: { ...CONTROL, width: '100%' }, onChange: event => setSelection(event.target.value) },
          !sessions.length ? h('option', { value: selection }, selection || '暂无已记录会话') : null,
          sessions.map(session => h('option', { key: session.sessionId, value: session.sessionId },
            session.sessionId + ' · ' + session.stepCount + ' 步')))) : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 } },
        h('select', { 'aria-label': '步骤排序', value: sort, onChange: event => setSort(event.target.value), style: CONTROL },
          h('option', { value: 'time' }, '按步骤顺序'), h('option', { value: 'risk' }, '按估计概率')),
        h('button', { type: 'button', onClick: () => setRefresh(value => value + 1), style: { ...CONTROL, cursor: 'pointer' } }, '刷新'),
        h('span', { style: { color: MUTED, fontSize: 12 } }, rows.length, ' 步')),
      state.error ? h('div', {
        role: 'alert', style: { border: '1px solid ' + BORDER, borderRadius: 8, padding: 10, lineHeight: 1.6, marginBottom: 12 },
      }, state.error, data ? ' 当前保留上次成功读取的数据。' : ' 请确认插件 Host 已启用。') : null,
      state.loading && !data ? h('p', { role: 'status', style: { color: MUTED } }, '正在读取步骤记录…') : null,
      !state.loading && !rows.length && !state.error ? h('p', { style: { color: MUTED, lineHeight: 1.7 } },
        '暂无已完成步骤。启用插件后，在会话中完成一个新步骤即可看到估计。') : null,
      h('div', { style: { display: 'grid', gap: 10 } },
        rows.map(row => h(StepCard, { key: row.sessionId + ':' + row.turn + ':' + row.step, row }))),
      data && data.updatedAt ? h('p', { style: { color: MUTED, fontSize: 11, marginTop: 12 } },
        '最近记录：', time(data.updatedAt), ' · 页面可见时每 2 秒刷新') : null)
    }

    function NativePanel(props) {
      const info = props.useTabInfo()
      return h(StepRiskPanel, { sessionId: props.sessionId, visible: info.tab.visible })
    }

    function SettingsPanel() {
      return h(StepRiskPanel, { global: true })
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section', id: 'dsh-step-risk', order: 45,
        label: () => 'Step Risk 步骤风险',
      }, SettingsPanel)), 'dsh-step-risk.settings')
      ctx.inject(['sidebarRightTabs'], inner => {
        const tabs = inner.get('sidebarRightTabs')
        inner.effect(() => tabs.register({
          id: TAB, kind: TAB, title: () => 'Step Risk',
          guide: [{ id: 'overview', order: 65, title: () => 'Step Risk', description: () => '查看每步最终失败概率的模型估计' }],
        }), 'dsh-step-risk.tab')
        inner.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab', key: TAB,
        }, NativePanel)), 'dsh-step-risk.tab-body')
      })
    }

    return { name: 'dsh-step-risk', inject: ['slots'], apply }
  },
})
