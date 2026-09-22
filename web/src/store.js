// 数据层：本地缓存（按用户隔离）+ GitHub 私有仓库云端同步（每用户独立文件）
// 键名兼容旧版：weight-log-data-v1（首个用户初始数据源）/ wt_gh_token / wt_user_id
import { reactive, computed } from 'vue'

const LS_KEY = 'weight-log-data-v1'
const TOKEN_KEY = 'wt_gh_token'
const UID_KEY = 'wt_user_id'

export const CFG = {
  owner: 'tan17ocean',
  dataRepo: 'weight-tracker-data', // 私有数据仓库：所有用户的云端数据只写这里
  base: 'data/users',              // 每个用户一个文件
  legacyRaw: 'https://raw.githubusercontent.com/tan17ocean/weight-tracker/main/data.json' // 旧版公开数据，仅首次迁移使用
}

function filePath(uid) {
  return `${CFG.base}/${encodeURIComponent(uid)}.json`
}
function fileApi(uid) {
  return `https://api.github.com/repos/${CFG.owner}/${CFG.dataRepo}/contents/${filePath(uid)}`
}

/* ---------- 数据规范化与合并（与旧版一致） ---------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function normalize(d) {
  const recs = Array.isArray(d && d.records)
    ? d.records
        .filter((r) => r && typeof r.date === 'string' && DATE_RE.test(r.date) && typeof r.weight === 'number' && isFinite(r.weight))
        .map((r) => ({ date: r.date, weight: r.weight, note: typeof r.note === 'string' ? r.note : '' }))
    : []
  return {
    records: recs,
    goal: d && typeof d.goal === 'number' && d.goal > 0 ? d.goal : null,
    height: d && typeof d.height === 'number' && d.height > 0 ? d.height : null
  }
}

function mergeRecords(cur, incoming) {
  const map = {}
  cur.forEach((r) => { map[r.date] = r })
  incoming.forEach((r) => { map[r.date] = r }) // 同日期以新（incoming）为准
  return Object.keys(map).sort().map((k) => map[k])
}

function mergeData(local, remote) {
  return {
    records: mergeRecords(local.records, remote.records),
    goal: local.goal || remote.goal,
    height: local.height || remote.height
  }
}

function dataEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function fmtDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const todayStr = () => fmtDate(new Date())

/* ---------- 用户身份 ---------- */
export function getUserId() {
  try { return localStorage.getItem(UID_KEY) || '' } catch (e) { return '' }
}
export function setUserId(uid) {
  const safe = String(uid || '').trim().slice(0, 40).replace(/[\\/:*?"<>|#%{}\s]/g, '')
  try {
    if (safe) localStorage.setItem(UID_KEY, safe)
    else localStorage.removeItem(UID_KEY)
  } catch (e) { /* ignore */ }
  return safe
}
// 切换当前用户：写入身份 → 重载该用户的本地数据（首次自动迁移旧共享数据）→ 重置远端 sha 缓存
export function switchUser(uid) {
  const safe = setUserId(uid)
  const data = loadLocal()
  state.records = data.records
  state.goal = data.goal
  state.height = data.height
  lastSha = null
  return safe
}

/* ---------- 本地存取（按用户分键，兼容旧键迁移） ---------- */
function localKey() {
  const uid = getUserId()
  return uid ? `${LS_KEY}:${uid}` : LS_KEY
}
function loadLocal() {
  let raw = null
  try { raw = localStorage.getItem(localKey()) } catch (e) { /* ignore */ }
  if (!raw && getUserId()) {
    // 首次按用户读取：若存在旧版共享数据，将其迁移为该用户的初始数据
    try {
      raw = localStorage.getItem(LS_KEY)
      if (raw) localStorage.setItem(localKey(), raw)
    } catch (e) { /* ignore */ }
  }
  if (raw) {
    try { return normalize(JSON.parse(raw)) } catch (e) { /* ignore */ }
  }
  return { records: [], goal: null, height: null }
}
function saveLocal() {
  try { localStorage.setItem(localKey(), JSON.stringify({ records: state.records, goal: state.goal, height: state.height })) } catch (e) { /* ignore */ }
}

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch (e) { return '' }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch (e) { /* ignore */ }
}

/* ---------- 响应式状态 ---------- */
const state = reactive({
  ...loadLocal(),
  syncState: 'idle', // idle | syncing | ok | local | error
  syncMsg: ''
})

export const store = state

let lastSha = null

export const stats = computed(() => {
  const sorted = state.records.slice().sort((a, b) => (a.date < b.date ? -1 : 1))
  if (!sorted.length) return { empty: true, cards: [] }
  const last = sorted[sorted.length - 1]
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null
  const first = sorted[0]

  const avgBetween = (startStr) => {
    const list = sorted.filter((r) => r.date >= startStr)
    if (!list.length) return null
    return list.reduce((s, r) => s + r.weight, 0) / list.length
  }
  const fmtDiff = (d) => {
    if (d === null || d === undefined || !isFinite(d)) return '--'
    const sign = d > 0 ? '+' : ''
    return `${sign}${d.toFixed(1)} kg`
  }

  const d6 = new Date(); d6.setDate(d6.getDate() - 6)
  const d29 = new Date(); d29.setDate(d29.getDate() - 29)
  const avg7 = avgBetween(fmtDate(d6))
  const avg30 = avgBetween(fmtDate(d29))
  const ws = sorted.map((r) => r.weight)
  const maxW = Math.max(...ws)
  const minW = Math.min(...ws)

  const cards = []
  cards.push({ label: '当前体重', value: last.weight.toFixed(1), unit: 'kg', hint: `更新于 ${last.date.slice(5)}` })
  if (prev) {
    const dLast = last.weight - prev.weight
    cards.push({
      label: '较上次变化', value: fmtDiff(dLast), hint: `上次 ${prev.date.slice(5)}`,
      cls: dLast > 0 ? 'up' : dLast < 0 ? 'down' : ''
    })
  }
  const dStart = last.weight - first.weight
  cards.push({
    label: '较起始变化', value: fmtDiff(dStart), hint: `起始 ${first.date.slice(5)}`,
    cls: dStart > 0 ? 'up' : dStart < 0 ? 'down' : ''
  })
  if (avg7 !== null) cards.push({ label: '近 7 天均值', value: avg7.toFixed(1), unit: 'kg' })
  if (avg30 !== null) cards.push({ label: '近 30 天均值', value: avg30.toFixed(1), unit: 'kg' })
  cards.push({ label: '最高 / 最低', value: `${maxW.toFixed(1)} / ${minW.toFixed(1)}`, unit: 'kg' })
  if (state.height) {
    const h = state.height / 100
    const bmi = last.weight / (h * h)
    const bmiHint = bmi < 18.5 ? '偏瘦' : bmi < 24 ? '正常' : bmi < 28 ? '偏胖' : '肥胖'
    cards.push({ label: 'BMI', value: bmi.toFixed(1), hint: bmiHint, cls: bmi < 24 ? '' : 'up' })
  }
  if (state.goal !== null) {
    const left = last.weight - state.goal
    cards.push(
      left > 0
        ? { label: '距目标', value: left.toFixed(1), unit: 'kg', hint: `目标 ${state.goal}，还需减重`, cls: 'up' }
        : { label: '距目标', value: '达成', hint: `目标 ${state.goal} kg 已达成`, cls: 'ok' }
    )
  }
  return { empty: false, cards, sorted }
})

/* ---------- 减肥进度 ---------- */
export const progress = computed(() => {
  const sorted = state.records.slice().sort((a, b) => (a.date < b.date ? -1 : 1))
  if (!sorted.length) return { empty: true, hasGoal: !!state.goal, goal: state.goal, cur: null, start: null, pct: 0, done: 0, need: 0, reached: false, direction: 'keep' }
  const start = sorted[0].weight
  const cur = sorted[sorted.length - 1].weight
  const goal = state.goal
  if (goal === null) {
    return { empty: false, hasGoal: false, goal: null, cur, start, pct: 0, done: start - cur, need: 0, reached: false, direction: 'keep' }
  }
  const direction = goal < start ? 'lose' : goal > start ? 'gain' : 'keep'
  const total = Math.abs(start - goal)
  const done = start - cur
  let pct = 0
  if (direction === 'keep') {
    pct = Math.abs(done) < 0.05 ? 100 : 0
  } else if (direction === 'lose') {
    pct = total === 0 ? 100 : Math.min(100, Math.max(0, (done / total) * 100))
  } else {
    pct = total === 0 ? 100 : Math.min(100, Math.max(0, ((cur - start) / total) * 100))
  }
  const reached = direction !== 'keep'
    ? (direction === 'lose' ? cur <= goal : cur >= goal)
    : Math.abs(done) < 0.05
  return { empty: false, hasGoal: true, goal, cur, start, pct, done, need: Math.max(0, total - Math.abs(done)), reached, direction }
})

/* ---------- 同步状态 ---------- */
function setSyncState(s, msg) {
  state.syncState = s
  state.syncMsg = msg || ''
}
export const syncLabel = computed(() => {
  switch (state.syncState) {
    case 'ok': return '已同步'
    case 'syncing': return '同步中…'
    case 'error': return '同步失败'
    case 'local': return '本地模式'
    default: return '同步'
  }
})

function b64(s) {
  return btoa(unescape(encodeURIComponent(s)))
}
function b64decode(b64s) {
  const bin = atob(b64s.replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

const ghHeaders = () => ({ Authorization: `Bearer ${getToken()}`, Accept: 'application/vnd.github+json' })

function fetchRemote() {
  const uid = getUserId()
  if (!uid) return Promise.resolve(null)
  return fetch(fileApi(uid), { headers: ghHeaders() })
    .then((res) => {
      if (res.status === 401) throw new Error('Token 无效或已过期')
      if (res.status === 403) throw new Error(`Token 未授权私有数据仓库（需勾选 ${CFG.dataRepo}）`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json().then((j) => {
        lastSha = j.sha
        return JSON.parse(b64decode(j.content))
      })
    })
}

function getRemoteSha() {
  const uid = getUserId()
  return fetch(fileApi(uid), { headers: ghHeaders() })
    .then((res) => {
      if (res.status === 404) { lastSha = null; return null }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json().then((j) => { lastSha = j.sha; return j.sha })
    })
}

const why = (res, er) => {
  const reason = (er && (er.message || er.documentation_url)) || `HTTP ${res.status}`
  if (res.status === 401) return 'HTTP 401：Token 无效或已过期，请重新生成并粘贴'
  if (res.status === 403 && /rate/i.test(reason)) return 'HTTP 403：GitHub API 限流，请稍后重试'
  if (res.status === 403) return 'HTTP 403：Token 权限不足（需勾选 Contents: Read and write）'
  if (res.status === 404) return `HTTP 404：Token 未授权私有数据仓库 ${CFG.dataRepo}，或文件尚未创建（首次保存会自动创建）`
  if (res.status === 500) return 'HTTP 500：GitHub 服务器异常，自动重试后仍失败，请稍后再试'
  return reason
}

export function pushRemote() {
  const uid = getUserId()
  if (!uid) {
    setSyncState('local', '未设置用户昵称，数据仅保存在本机')
    return Promise.resolve(false)
  }
  if (!getToken()) {
    setSyncState('local', '未配置同步 Token（数据已存本地，可随时重试）')
    return Promise.resolve(false)
  }
  setSyncState('syncing', '正在同步…')
  let attempt = 0
  const doPush = () => {
    const p = lastSha !== null ? Promise.resolve(lastSha) : getRemoteSha()
    return p
      .then(() => {
        const payload = { records: state.records, goal: state.goal, height: state.height }
        if (lastSha === null) {
          // 首次写入：合并旧版公开 data.json，保证历史数据迁移不丢
          return fetch(CFG.legacyRaw, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null)
            .then((legacy) => (legacy ? mergeData(payload, normalize(legacy)) : payload))
        }
        return payload
      })
      .then((payload) => {
        const content = b64(JSON.stringify(payload, null, 2))
        const body = { message: `update weight data ${todayStr()}`, content }
        if (lastSha) body.sha = lastSha
        return fetch(fileApi(uid), {
          method: 'PUT',
          headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
      })
      .then((res) => {
        if (res.status >= 500 && attempt < 3) {
          attempt++
          setSyncState('syncing', `服务器繁忙（HTTP ${res.status}），第 ${attempt}/3 次重试…`)
          return new Promise((r) => setTimeout(r, 1500 * attempt)).then(doPush)
        }
        if (!res.ok) {
          return res.json().catch(() => null).then((er) => { throw new Error(why(res, er)) })
        }
        return res.json()
      })
  }
  return doPush()
    .then((j) => {
      lastSha = j.content && j.content.sha
      setSyncState('ok', `已同步上线 · ${todayStr()}`)
      return true
    })
    .catch((e) => {
      setSyncState('error', `同步失败：${e.message}`)
      return false
    })
}

export function pullAndMerge() {
  if (!getUserId()) {
    setSyncState('local', '未设置用户昵称，先在顶部设置昵称即可云端隔离存储')
    return
  }
  if (!getToken()) {
    setSyncState('local', '未配置同步 Token（数据已存本地）')
    return
  }
  fetchRemote()
    .then((remote) => {
      if (remote === null) {
        const dirty = state.records.length > 0
        setSyncState(dirty ? 'local' : 'ok', dirty ? '线上暂无数据，本地有内容待上传' : '线上暂无数据')
        if (dirty && getToken()) pushRemote()
        return
      }
      const rn = normalize(remote)
      const merged = mergeData({ records: state.records, goal: state.goal, height: state.height }, rn)
      const changed = !dataEq(merged, { records: state.records, goal: state.goal, height: state.height })
      const hasToken = !!getToken()
      state.records = merged.records
      state.goal = merged.goal
      state.height = merged.height
      saveLocal()
      const localExtra = state.records.length > rn.records.length
      if (changed || localExtra || ((state.goal || state.height) && !rn.goal && !rn.height)) {
        if (hasToken) pushRemote()
        else setSyncState('local', '检测到未同步的本地数据，配置 Token 后自动上传')
      } else {
        setSyncState(hasToken ? 'ok' : 'local', hasToken ? `已从线上载入 ${rn.records.length} 条记录` : '已载入线上数据（未配置 Token）')
      }
    })
    .catch((e) => {
      setSyncState('local', `线上读取失败，使用本地数据（${e.message}）`)
    })
}

/* ---------- 业务操作 ---------- */
export function addOrUpdateRecord(date, weight, note) {
  const idx = state.records.findIndex((r) => r.date === date)
  if (idx >= 0) state.records[idx] = { date, weight, note }
  else state.records.push({ date, weight, note })
  saveLocal()
  pushRemote()
}

export function deleteRecord(date) {
  state.records = state.records.filter((r) => r.date !== date)
  saveLocal()
  pushRemote()
}

export function saveSettings(goal, height) {
  state.goal = goal
  state.height = height
  saveLocal()
  pushRemote()
}

export function importData(records, goal, height) {
  setStoreRecords(mergeRecords(state.records, records))
  if (goal !== null) state.goal = goal
  if (height !== null) state.height = height
  saveLocal()
  pushRemote()
}

// 兼容写回 store 中 records 的辅助函数
function setStoreRecords(recs) {
  state.records = recs
}

export function exportData() {
  const blob = new Blob([JSON.stringify({ records: state.records, goal: state.goal, height: state.height }, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `weight-records-${todayStr()}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}