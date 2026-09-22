<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import './styles/main.css'
import {
  store, stats, progress, syncLabel, CFG,
  getToken, setToken, pushRemote, pullAndMerge,
  addOrUpdateRecord, deleteRecord, saveSettings, importData, exportData, normalize
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
  const idx = store.records.findIndex((r) => r.date === form.date)
  if (idx >= 0 && editing.value !== form.date) {
    if (!confirm(`该日期已有记录（${store.records[idx].weight} kg），是否覆盖？`)) return
  }
  addOrUpdateRecord(form.date, weight, form.note.trim())
  clearForm()
}

function startEdit(date) {
  const r = store.records.find((x) => x.date === date)
  if (!r) return
  editing.value = date
  form.date = r.date
  form.weight = r.weight
  form.note = r.note || ''
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function delRecord(date) {
  if (!confirm(`确定删除 ${date} 的记录吗？`)) return
  deleteRecord(date)
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

/* ---------- Token ---------- */
const tokenInput = ref('')
const hasToken = computed(() => !!getToken())
function saveToken() {
  const t = tokenInput.value.trim()
  if (!t) { alert('请输入 Token'); return }
  setToken(t)
  tokenInput.value = ''
  if (store.records.length) pushRemote()
  else setSyncStateLocal('Token 已保存，提交数据后自动上线同步')
}
function setSyncStateLocal(msg) {
  // 简单状态提示（无 token 时不改变大类状态）
  store.syncMsg = msg
  store.syncState = 'local'
}
function clearToken() {
  if (!confirm('清除后本浏览器将无法自动上传数据，确认清除？')) return
  setToken('')
  store.syncMsg = 'Token 已清除，仅保留本地数据'
  store.syncState = 'local'
}

function manualSync() {
  if (!getToken()) { openSync(); return }
  pushRemote()
}
function openSync() {
  syncPanel.value = true
  setTimeout(() => document.getElementById('inToken')?.focus(), 50)
}
const syncPanel = ref(false)

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
      alert(`导入成功，共合并 ${nd.records.length} 条记录（同日期以新文件为准）`)
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
const sortedDesc = computed(() => store.records.slice().sort((a, b) => (a.date < b.date ? 1 : -1)))

/* ---------- 趋势图（SVG） ---------- */
const W = 800, H = 300
const M = { t: 20, r: 20, b: 32, l: 46 }
const chart = computed(() => {
  const sorted = store.records.slice().sort((a, b) => (a.date < b.date ? -1 : 1))
  if (!sorted.length) return { empty: true }
  const ms = sorted.map((r) => new Date(r.date + 'T00:00:00').getTime())
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
    `<b>${p.r.date}</b><br>${p.r.weight.toFixed(1)} kg` +
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
            正在编辑 {{ editing }} 的记录
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
          <summary>数据同步（GitHub）</summary>
          <div class="setting-body">
            <div class="hint">提交后数据会自动上传到仓库 <code>{{ CFG.owner }}/{{ CFG.repo }}/data.json</code>，任何设备打开本页自动读取。Token 仅保存在你当前浏览器，不会随网页公开。</div>
            <div class="field">
              <label for="inToken">GitHub Token</label>
              <input type="password" id="inToken" v-model="tokenInput" placeholder="ghp_... / github_pat_..." autocomplete="off">
            </div>
            <div class="form-row-btns">
              <button class="btn small" @click="saveToken">保存 Token</button>
              <button class="btn small" v-if="hasToken" @click="clearToken">清除</button>
            </div>
            <div class="hint">安全建议：专为此站生成 <b>Fine-grained Token</b>（仅勾选 <code>{{ CFG.repo }}</code> 仓库、权限 <code>Contents: Read and write</code>），不要使用高权限总 Token。</div>
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
            v-for="p in chart.pts" :key="p.r.date"
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
        <li class="row" v-for="r in sortedDesc" :key="r.date">
          <div class="row-main">
            <span class="date">{{ r.date }}</span>
            <span class="rel" v-if="relLabel(r.date)">{{ relLabel(r.date) }}</span>
            <span class="weight">{{ r.weight.toFixed(1) }} kg</span>
            <span class="note" v-if="r.note" :title="r.note">{{ r.note }}</span>
          </div>
          <div class="row-ops">
            <button class="link" @click="startEdit(r.date)">编辑</button>
            <button class="link danger" @click="delRecord(r.date)">删除</button>
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