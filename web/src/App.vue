<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import './styles/main.css'
import {
  store, stats, progress, syncLabel,
  pushRemote, pullAndMerge,
  getUserId, switchUser,
  addRecord, updateRecord, deleteRecord, saveSettings, importData, exportData, normalize, sortRecs
} from './store'
import { getTheme, setTheme } from './theme'

/* ---------- 主题 ---------- */
const theme = ref(getTheme())
function toggleTheme() {
  const next = theme.value === 'dark' ? 'light' : 'dark'
  theme.value = next
  setTheme(next)
}

/* ---------- 表单 ---------- */
const today = () => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
const form = reactive({ date: today(), weight: '', note: '' })
const editing = ref(null)

function clearForm() {
  editing.value = null
  form.date = today()
  form.weight = ''
  form.note = ''
}

function submit() {
  const weight = parseFloat(form.weight)
  if (!form.date) { alert('请选择日期'); return }
  if (!(weight >= 20 && weight <= 300)) { alert('请输入有效体重（20 - 300 kg）'); return }
  if (editing.value) {
    // 编辑模式：只更新这一条记录
    updateRecord(editing.value, { date: form.date, weight, note: form.note.trim() })
  } else {
    // 新增：总是追加一条，同一天可有多条，按录入时间区分
    addRecord(form.date, weight, form.note.trim())
  }
  clearForm()
}

// 录入时间（时:分），用于区分同日多条记录
function fmtTime(t) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const editingLabel = computed(() => {
  if (!editing.value) return ''
  const r = store.records.find((x) => x.id === editing.value)
  if (!r) return ''
  return `${r.date}${r.ts != null ? ' ' + fmtTime(r.ts) : ''}（${r.weight.toFixed(1)} kg）`
})

function startEdit(id) {
  const r = store.records.find((x) => x.id === id)
  if (!r) return
  editing.value = id
  form.date = r.date
  form.weight = r.weight
  form.note = r.note || ''
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function delRecord(id) {
  const r = store.records.find((x) => x.id === id)
  if (!r) return
  if (!confirm(`确定删除 ${r.date}${r.ts != null ? ' ' + fmtTime(r.ts) : ''} 的这条记录（${r.weight.toFixed(1)} kg）吗？`)) return
  deleteRecord(id)
}

/* ---------- 设置 ---------- */
const settings = reactive({ goal: '', height: '' })
watch(
  () => [store.goal, store.height],
  ([g, h]) => {
    settings.goal = g !== null ? g : ''
    settings.height = h !== null ? h : ''
  },
  { immediate: true }
)

function saveGoalHeight() {
  const g = parseFloat(settings.goal)
  const h = parseFloat(settings.height)
  if (settings.goal !== '' && !(g >= 20 && g <= 300)) { alert('目标体重无效（20 - 300 kg）'); return }
  if (settings.height !== '' && !(h >= 80 && h <= 250)) { alert('身高无效（80 - 250 cm）'); return }
  saveSettings(settings.goal === '' ? null : g, settings.height === '' ? null : h)
  alert('设置已保存')
}

/* ---------- 减肥进度：目标体重内联编辑 ---------- */
const editingGoal = ref(false)
const goalInput = ref('')
const goalSaving = ref(false)
const hasGoalSet = computed(() => store.goal !== null && store.goal > 0)
const pctClamped = computed(() => (progress.value ? Math.min(100, Math.max(0, progress.value.pct)) : 0))
const progClass = computed(() => {
  if (!progress.value) return ''
  if (progress.value.reached) return 'prog-done'
  if (pctClamped.value >= 80) return 'prog-high'
  if (pctClamped.value >= 40) return 'prog-mid'
  return 'prog-low'
})
const over = computed(() => {
  if (!progress.value || !progress.value.reached) return 0
  const total = Math.abs(progress.value.goal - progress.value.start)
  return Math.max(0, Math.abs(progress.value.done) - total)
})
const progDoneCls = computed(() => {
  if (!progress.value || progress.value.direction === 'keep') return ''
  const good = progress.value.direction === 'lose' ? progress.value.done > 0 : progress.value.done < 0
  return good ? 'down' : 'up'
})
const progDoneText = computed(() => {
  if (!progress.value) return ''
  const sign = progress.value.done >= 0 ? '+' : '-'
  return `${sign}${Math.abs(progress.value.done).toFixed(1)} kg`
})
function startGoalEdit() {
  editingGoal.value = true
  goalInput.value = store.goal !== null ? store.goal : ''
}
function saveGoal() {
  if (goalSaving.value) return
  const g = parseFloat(goalInput.value)
  if (goalInput.value === '') {
    if (!confirm('清空目标体重？')) return
    goalInput.value = ''
    saveSettings(null, store.height)
  } else {
    if (!(g >= 20 && g <= 300)) { alert('目标体重无效（20 - 300 kg）'); return }
    saveSettings(g, store.height)
  }
  editingGoal.value = false
  goalSaving.value = true
  setTimeout(() => { goalSaving.value = false }, 500)
}

/* ---------- 用户昵称 ---------- */
const uid = ref(getUserId())
const uidInput = ref('')
function saveUid() {
  const safe = switchUser(uidInput.value)
  uidInput.value = ''
  if (!safe) {
    alert('昵称已清除，数据将只保存在本机。重新设置昵称即可恢复云端同步')
  } else {
    uid.value = safe
    pullAndMerge()
  }
}
function clearUid() {
  if (!confirm('清除昵称？该用户数据仍保留在云端文件中，重新输入相同昵称即可恢复。')) return
  switchUser('')
  uid.value = ''
  uidInput.value = ''
  store.syncMsg = '已清除昵称，当前为本地模式'
  store.syncState = 'local'
}

/* ---------- 同步（经 Cloudflare Worker 代理，无需任何 Token） ---------- */
function manualSync() {
  if (!uid.value) { openSync('inUid'); return }
  pushRemote()
}
function openSync(focusId) {
  syncPanel.value = true
  setTimeout(() => document.getElementById(focusId || 'inUid')?.focus(), 50)
}
const syncPanel = ref(false)
function openSyncPanel() { openSync('inUid') }

/* ---------- 导入 ---------- */
const fileInput = ref(null)
function onPickImport() { fileInput.value.click() }
function onImport(ev) {
  const f = ev.target.files[0]
  ev.target.value = ''
  if (!f) return
  const rd = new FileReader()
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result)
      const nd = normalize({ records: d.records, goal: d.goal, height: d.height })
      if (!nd.records.length && !d.records) { alert('导入失败：文件中没有有效的记录数据'); return }
importData(nd.records, nd.goal, nd.height)
      alert(`导入成功，共合并 ${nd.records.length} 条记录（按条合并，同日多条均保留）`)
    } catch (e) { alert('导入失败：文件不是有效的 JSON 备份文件') }
  }
  rd.readAsText(f, 'utf-8')
}

/* ---------- 列表相对日期 ---------- */
function relLabel(ds) {
  const t = today()
  if (ds === t) return '今天'
  const y = new Date(); y.setDate(y.getDate() - 1)
  return ds === fmt(y) ? '昨天' : ''
}
function fmt(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
const sortedDesc = computed(() => sortRecs(store.records).reverse())

/* ---------- 趋势图（SVG） ---------- */
const W = 800, H = 300
const M = { t: 20, r: 20, b: 32, l: 46 }
const DAY_MS = 86400000
const chart = computed(() => {
  const sorted = sortRecs(store.records)
  if (!sorted.length) return { empty: true }
  // 同一日期多条记录：单条用真实录入时刻，多条按当天时间均匀展开，避免点重叠
  const groups = new Map()
  sorted.forEach((r) => { if (!groups.has(r.date)) groups.set(r.date, []); groups.get(r.date).push(r) })
  const fracOf = (r) => (r.ts == null ? 0 : ((r.ts % DAY_MS) + DAY_MS) % DAY_MS)
  const ms = sorted.map((r) => {
    const dayStart = new Date(r.date + 'T00:00:00').getTime()
    const g = groups.get(r.date)
    if (g.length <= 1) return dayStart + fracOf(r)
    const ordered = g.slice().sort((a, b) => fracOf(a) - fracOf(b))
    const i = ordered.indexOf(r)
    return dayStart + (DAY_MS / g.length) * (i + 0.5)
  })
  const ws = sorted.map((r) => r.weight)
  let minW = Math.min(...ws), maxW = Math.max(...ws)
  if (minW === maxW) { minW -= 1; maxW += 1 }
  const pad = (maxW - minW) * 0.12; minW -= pad; maxW += pad
  const pw = W - M.l - M.r, ph = H - M.t - M.b
  const X = (t) => M.l + ((ms[0] === ms[ms.length - 1]) ? pw / 2 : (t - ms[0]) / (ms[ms.length - 1] - ms[0]) * pw)
  const Y = (w) => M.t + ph - (w - minW) / (maxW - minW) * ph

  const gridLines = []
  for (let i = 0; i <= 4; i++) {
    const wv = minW + (maxW - minW) * i / 4
    gridLines.push({ y: Y(wv), label: wv.toFixed(1) })
  }
  const xLabels = []
  const idxs = [0, Math.floor((sorted.length - 1) / 2), sorted.length - 1]
  const seenX = {}
  for (const i0 of idxs) {
    const xx = X(ms[i0])
    if (seenX[xx.toFixed(0)]) continue
    seenX[xx.toFixed(0)] = true
    xLabels.push({ x: xx, text: sorted[i0].date.slice(5) })
  }
  const goalLine = store.goal !== null ? { y: Y(store.goal), label: `目标 ${store.goal} kg`, inRange: Y(store.goal) >= M.t - 8 && Y(store.goal) <= H - M.b + 8 } : null

  const pts = sorted.map((r, j) => ({ x: X(ms[j]), y: Y(r.weight), r }))
  const lineD = 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')
  const areaD = `${lineD} L${pts[pts.length - 1].x.toFixed(1)},${H - M.b} L${pts[0].x.toFixed(1)},${H - M.b} Z`

  return {
    empty: false, pts, lineD, areaD, gridLines, xLabels, goalLine,
    meta: `共 ${sorted.length} 条 · ${sorted[0].date} 至 ${sorted[sorted.length - 1].date}`
  }
})

const tip = reactive({ show: false, left: 0, top: 0, html: '' })
const chartWrap = ref(null)
function showTip(ev, p) {
  const wrap = chartWrap.value
  if (!wrap) return
  const rect = wrap.getBoundingClientRect()
  const scaleX = rect.width / W, scaleY = rect.height / H
  let left = p.x * scaleX + 10
  if (left > rect.width - 140) left = p.x * scaleX - 150
  tip.show = true
  tip.left = left
  tip.top = p.y * scaleY - 12
tip.html =
    `<b>${p.r.date}</b>${p.r.ts != null ? ` <span class="tip-ts">${fmtTime(p.r.ts)}</span>` : ''}<br>${p.r.weight.toFixed(1)} kg` +
    (p.r.note ? `<br><span class="tip-note">${esc(p.r.note)}</span>` : '')
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function hideTip() { tip.show = false }

/* ---------- 初始化 ---------- */
onMounted(() => {
  pullAndMerge()
})
</script>

<template>
  <header class="app-header">
    <div class="head">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5 13.5 4.75v6.5L8 14.5l-5.5-3.25v-6.5L8 1.5Z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="8" cy="8" r="2.1" fill="#fff"/>
        </svg>
      </div>
      <div class="brand"><b>体重记录</b><span>Weight Tracker</span></div>
      <div class="spacer"></div>
      <button class="btn" @click="openSyncPanel" :title="uid ? `当前用户：${uid}（点击切换）` : '设置昵称后数据将按用户独立存入云端'">
        <span class="user-chip">{{ uid ? uid : '设置昵称' }}</span>
      </button>
      <button class="btn" @click="exportData()">导出数据</button>
      <button class="btn" @click="onPickImport">导入数据</button>
      <button class="btn" @click="manualSync" :title="store.syncMsg">
        <span class="dot" :class="store.syncState === 'ok' ? 'ok' : store.syncState === 'syncing' ? 'syncing' : store.syncState === 'error' ? 'error' : 'local'"></span>
        <span>{{ syncLabel }}</span>
      </button>
      <button class="btn" @click="toggleTheme" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'">
        <svg v-if="theme === 'dark'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
        <span>主题</span>
      </button>
      <input type="file" ref="fileInput" accept=".json,application/json" hidden @change="onImport">
    </div>
  </header>

  <main class="wrap">
    <div class="grid">
      <!-- 左栏：表单 + 设置 -->
      <div class="card">
        <h3 class="card-title"><i>＋</i>添加记录</h3>
        <form class="form" @submit.prevent="submit" autocomplete="off">
          <div class="field">
            <label for="inDate">日期</label>
            <input type="date" id="inDate" v-model="form.date" required>
          </div>
          <div class="field">
            <label for="inWeight">体重（kg）</label>
            <input type="number" id="inWeight" v-model="form.weight" min="20" max="300" step="0.1" required placeholder="如 72.5">
          </div>
          <div class="field">
            <label for="inNote">备注</label>
            <input type="text" id="inNote" v-model="form.note" maxlength="50" placeholder="可选，如：早晨空腹">
          </div>
          <button type="submit" class="btn primary" style="justify-content:center;">保存记录</button>
<div class="edit-hint" :hidden="editing === null">
            正在编辑 {{ editingLabel }}
            <button type="button" class="link" @click="clearForm">取消</button>
          </div>
        </form>

        <details>
          <summary>目标与身体参数</summary>
          <div class="setting-body">
            <div class="field">
              <label for="inGoal">目标体重（kg）</label>
              <input type="number" id="inGoal" v-model="settings.goal" min="20" max="300" step="0.1" placeholder="可选">
            </div>
            <div class="field">
              <label for="inHeight">身高（cm）</label>
              <input type="number" id="inHeight" v-model="settings.height" min="80" max="250" step="0.5" placeholder="用于 BMI 计算">
            </div>
            <div><button class="btn small" @click="saveGoalHeight">保存设置</button></div>
          </div>
        </details>

<details :open="syncPanel" @toggle="syncPanel = $event.target.open">
          <summary>数据同步（自动云端，无需配置）</summary>
          <div class="setting-body">
            <div class="hint">设置昵称后，数据会自动同步到云端私有仓库中你自己的文件（<code>data/users/{{ uid || '昵称' }}.json</code>），每个昵称彼此隔离、仅对应访问者自己可见。同步经 Cloudflare Worker 代理完成，<b>站点密钥与 GitHub Token 都只存在于服务端，任何访客（包括开发者工具）都看不到明文 Token</b>；未设置昵称时自动降级为本地模式（仅存本机浏览器）。</div>
            <div class="field">
              <label for="inUid">我的昵称（用户隔离标识）</label>
              <input type="text" id="inUid" v-model="uidInput" :placeholder="uid ? `当前：${uid}（输入新昵称后切换）` : '如：小陈'" maxlength="40" autocomplete="off">
            </div>
            <div class="form-row-btns">
              <button class="btn small" @click="saveUid">保存昵称</button>
              <button class="btn small" v-if="uid" @click="clearUid">清除昵称</button>
            </div>
            <div class="hint" v-if="uid">正在使用昵称 <b>{{ uid }}</b>，云端读写独立文件；每次保存数据后会自动同步，无需手动操作。</div>
          </div>
        </details>
      </div>

      <!-- 右栏：统计 -->
      <div class="card">
        <h3 class="card-title"><i>📊</i>统计</h3>
        <div class="stats">
          <template v-if="!stats.empty">
            <div class="stat" v-for="c in stats.cards" :key="c.label">
              <div class="stat-label">{{ c.label }}</div>
              <div class="stat-value" :class="c.cls || ''">{{ c.value }}<span v-if="c.unit" class="unit">{{ c.unit }}</span></div>
              <div class="stat-hint" v-if="c.hint">{{ c.hint }}</div>
            </div>
          </template>
          <div v-else class="stat stat-empty">
            <div class="stat-label">暂无数据</div>
            <div class="stat-hint">添加第一条记录后显示统计</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 减肥进度 -->
    <div class="card prog-card">
      <div class="prog-head">
        <h3 class="card-title" style="margin-bottom:0;"><i>🎯</i>减肥进度</h3>
        <div class="prog-goal" v-if="hasGoalSet">
          <template v-if="!editingGoal">
            <span class="prog-goal-num">目标 <b>{{ store.goal }}</b> kg</span>
            <button class="btn small" @click="startGoalEdit">修改</button>
          </template>
          <template v-else>
            <input type="number" id="inGoalInline" v-model="goalInput" min="20" max="300" step="0.1" placeholder="目标体重 kg" @keyup.enter="saveGoal">
            <button class="btn small primary" @click="saveGoal">保存</button>
            <button class="btn small" @click="editingGoal = false">取消</button>
          </template>
        </div>
        <button class="btn small" v-else @click="startGoalEdit">设置目标体重</button>
      </div>

      <div v-if="progress.empty || !hasGoalSet" class="prog-empty">
        <template v-if="progress.empty">还没有记录，先添加第一条体重记录，再设置目标即可查看进度。</template>
        <template v-else>
          目标体重未设置。设置后即可查看减肥进度。当前体重 <b>{{ progress.cur.toFixed(1) }}</b> kg。
        </template>
        <div v-if="editingGoal && !hasGoalSet" class="prog-inline">
          <input type="number" id="inGoalInline" v-model="goalInput" min="20" max="300" step="0.1" placeholder="目标体重（kg）" @keyup.enter="saveGoal">
          <button class="btn small primary" @click="saveGoal">保存目标</button>
          <button class="btn small" @click="editingGoal = false">取消</button>
        </div>
      </div>

      <template v-else>
        <div class="prog-bar-wrap">
          <div class="prog-bar" :class="progClass">
            <div class="prog-fill" :style="{ width: pctClamped + '%' }"></div>
            <span class="prog-pct">{{ Math.round(pctClamped) }}%</span>
          </div>
        </div>
        <div class="prog-meta">
          <div class="prog-point">
            <span class="prog-label">起始</span>
            <span class="prog-val">{{ progress.start.toFixed(1) }}</span>
            <span class="prog-unit">kg</span>
          </div>
          <div class="prog-arrow">→</div>
          <div class="prog-point">
            <span class="prog-label">当前</span>
            <span class="prog-val">{{ progress.cur.toFixed(1) }}</span>
            <span class="prog-unit">kg</span>
          </div>
          <div class="prog-arrow">→</div>
          <div class="prog-point">
            <span class="prog-label">目标</span>
            <span class="prog-val" :class="{ done: progress.reached }">{{ store.goal }}</span>
            <span class="prog-unit">kg</span>
          </div>
        </div>
        <div class="prog-stats">
          <div class="prog-stat" v-if="progress.reached">
            <span class="prog-stat-label">状态</span>
            <span class="prog-badge done">🎉 目标已达成</span>
          </div>
          <div class="prog-stat">
            <span class="prog-stat-label">{{ progress.direction === 'lose' ? '已减' : progress.direction === 'gain' ? '已增' : '变动' }}</span>
            <span class="prog-stat-num" :class="progDoneCls">{{ progDoneText }}</span>
          </div>
          <div class="prog-stat" v-if="!progress.reached">
            <span class="prog-stat-label">{{ progress.direction === 'lose' ? '还需减重' : progress.direction === 'gain' ? '还需增重' : '仍偏离' }}</span>
            <span class="prog-stat-num">{{ progress.need.toFixed(1) }} kg</span>
          </div>
          <div class="prog-stat" v-else>
            <span class="prog-stat-label">超额</span>
            <span class="prog-stat-num down">{{ over.toFixed(1) }} kg</span>
          </div>
        </div>
      </template>
    </div>

    <!-- 趋势图 -->
    <div class="card" v-if="!chart.empty">
      <div class="chart-head">
        <h3 class="card-title" style="margin-bottom:0;"><i>📈</i>体重趋势</h3>
        <span class="hint">{{ chart.meta }}</span>
      </div>
      <div class="chart-wrap" ref="chartWrap" @mouseleave="hideTip">
        <svg viewBox="0 0 800 300" role="img" aria-label="体重趋势折线图">
          <defs>
            <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.16"/>
              <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <g class="grid-line" v-for="g in chart.gridLines" :key="g.y">
            <line :x1="M.l" :y1="g.y" :x2="W - M.r" :y2="g.y"/>
            <text :x="M.l - 8" :y="g.y + 4" text-anchor="end" font-size="11" fill="var(--text-muted)">{{ g.label }}</text>
          </g>
          <g class="x-label" v-for="xl in chart.xLabels" :key="xl.x">
            <text :x="xl.x" :y="H - M.b + 18" text-anchor="middle" font-size="11" fill="var(--text-muted)">{{ xl.text }}</text>
          </g>
          <g v-if="chart.goalLine && chart.goalLine.inRange">
            <line class="goal-line" :x1="M.l" :y1="chart.goalLine.y" :x2="W - M.r" :y2="chart.goalLine.y"/>
            <text :x="W - M.r - 2" :y="chart.goalLine.y - 6" text-anchor="end" font-size="11" fill="var(--red)">{{ chart.goalLine.label }}</text>
          </g>
          <path :d="chart.areaD" fill="url(#areaGrad)" stroke="none"/>
          <path class="trend-line" :d="chart.lineD"/>
<circle
            v-for="p in chart.pts" :key="p.r.id"
            class="trend-dot"
            :cx="p.x" :cy="p.y" r="4.5"
            @mouseenter="showTip($event, p)"
            @click="showTip($event, p)"
          />
        </svg>
        <div class="tip" :hidden="!tip.show" :style="{ left: tip.left + 'px', top: tip.top + 'px' }" v-html="tip.html"></div>
      </div>
    </div>
    <p class="empty" v-else>还没有数据，添加第一条记录后显示趋势图</p>

    <!-- 历史记录 -->
    <div class="card">
      <h3 class="card-title"><i>☰</i>历史记录 <span class="hint">共 {{ sortedDesc.length }} 条</span></h3>
      <ul class="list" v-if="sortedDesc.length">
<li class="row" v-for="r in sortedDesc" :key="r.id">
          <div class="row-main">
            <span class="date">{{ r.date }}</span>
            <span class="time" v-if="r.ts != null">{{ fmtTime(r.ts) }}</span>
            <span class="rel" v-if="relLabel(r.date)">{{ relLabel(r.date) }}</span>
            <span class="weight">{{ r.weight.toFixed(1) }} kg</span>
            <span class="note" v-if="r.note" :title="r.note">{{ r.note }}</span>
          </div>
          <div class="row-ops">
            <button class="link" @click="startEdit(r.id)">编辑</button>
            <button class="link danger" @click="delRecord(r.id)">删除</button>
          </div>
        </li>
      </ul>
      <p class="empty-line" v-else>暂无记录</p>
    </div>
  </main>

  <footer class="statusbar">
    <div class="statusbar-inner">
      <div class="sb-left">
        <span>本地缓存：<b>已启用</b></span>
        <span>{{ store.syncMsg }}</span>
      </div>
      <div class="sb-right" @click="manualSync" :title="store.syncMsg + '（点击重试）'">
        <span class="dot" :class="store.syncState === 'ok' ? 'ok' : store.syncState === 'syncing' ? 'syncing' : store.syncState === 'error' ? 'error' : 'local'"></span>
        <span>{{ syncLabel }}</span>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 12px; }
.grid-line line { stroke: var(--border); stroke-width: 1; }
.goal-line { stroke: var(--red); stroke-dasharray: 6 4; stroke-width: 1.5; opacity: .75; }
.trend-line { fill: none; stroke: var(--primary); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.trend-dot { fill: var(--bg-card); stroke: var(--primary); stroke-width: 2; cursor: pointer; transition: r .15s ease; }
.trend-dot:hover { r: 6; }
</style>