// 数据层：本地缓存（按用户隔离）+ Cloudflare Worker 代理云端同步（每用户独立文件）
// GitHub Token 只存放在 Worker 服务端环境变量，前端完全不可见；
// 前端仅持有 Worker 代理地址与站点密钥（密钥只用于代理鉴权，不会泄露 Token）。
// 键名兼容旧版：weight-log-data-v1 / wt_user_id / wt_first_user
import { reactive, computed } from 'vue'
import { buildXlsx } from './xlsx.js'

const LS_KEY = 'weight-log-data-v1'
const UID_KEY = 'wt_user_id'
const FIRST_USER_KEY = 'wt_first_user' // 本机第一个设置昵称的用户：唯一允许继承旧数据的用户
const DIRTY_KEY = 'wt_dirty' // 本地有改动未成功推送到云端时为 '1'（断网/失败期间置位，恢复后自动补推）

// 站点密钥：必须与 Worker 环境变量 SITE_KEY 完全一致（部署 Worker 时填入）
const SITE_KEY = 'wtsk-891daa4c581a01097189e6a1'

export const CFG = {
  // Cloudflare Worker 代理地址（已部署：weight-tracker-proxy）
  proxy: 'https://weight-tracker-proxy.1515618169.workers.dev',
  dataRepo: 'weight-tracker-data', // 私有数据仓库：所有用户的云端数据只写这里
  legacyRaw: 'https://raw.githubusercontent.com/tan17ocean/weight-tracker/main/data.json' // 旧版公开数据，仅首个用户首次迁移使用
}

function userApi(uid) {
  return `${CFG.proxy}/users/${encodeURIComponent(uid)}.json`
}
function proxyHeaders() {
  return { 'X-Site-Key': SITE_KEY, Accept: 'application/json' }
}
// 代理地址尚未替换为真实 Worker 域名时，视为云同步未就绪
function proxyReady() {
  return !/REPLACE_WITH_YOUR_WORKER/.test(CFG.proxy)
}

/* ---------- 数据规范化与合并 ---------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 记录唯一标识：新增时生成；旧数据（无 id）用内容拼出稳定值，同一条记录在本地/云端合并时不重复
function genId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function normalize(d) {
  const recs = Array.isArray(d && d.records)
    ? d.records
        .filter((r) => r && typeof r.date === 'string' && DATE_RE.test(r.date) && typeof r.weight === 'number' && isFinite(r.weight))
        .map((r) => ({
          id: typeof r.id === 'string' && r.id ? r.id : `${r.date}|${r.weight}|${typeof r.note === 'string' ? r.note : ''}`,
          date: r.date,
          weight: r.weight,
          note: typeof r.note === 'string' ? r.note : '',
          ts: typeof r.ts === 'number' && isFinite(r.ts) ? r.ts : null // 录入时间戳(ms)；旧数据无则 null
        }))
    : []
  return {
    records: recs,
    goal: d && typeof d.goal === 'number' && d.goal > 0 ? d.goal : null,
    height: d && typeof d.height === 'number' && d.height > 0 ? d.height : null,
    // 显示单位：'kg' | 'lb'，仅展示换算，存储始终为 kg；旧数据无该字段时为 null（按 kg 处理）
    unit: d && (d.unit === 'kg' || d.unit === 'lb') ? d.unit : null
  }
}

// 排序：日期升序 → 同日按录入时间升序（无时间的旧记录排最前）→ id 兜底
function sortCmp(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  const ta = a.ts, tb = b.ts
  if (ta !== tb) {
    if (ta == null) return -1
    if (tb == null) return 1
    return ta - tb
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
export function sortRecs(recs) { return recs.slice().sort(sortCmp) }

// 按 id 合并去重：同一 id 取新（incoming），不同 id 全部保留；不再按日期覆盖
function mergeRecords(cur, incoming) {
  const map = {}
  cur.forEach((r) => { map[r.id] = r })
  incoming.forEach((r) => { map[r.id] = r })
  return Object.keys(map).map((k) => map[k]).sort(sortCmp)
}

function mergeData(local, remote) {
  // unit 属展示偏好：本地已设置则优先本地，否则取远端（远端任务数据文件中可能保存了用户偏好）
  return {
    records: mergeRecords(local.records, remote.records),
    goal: local.goal || remote.goal,
    height: local.height || remote.height,
    unit: (local.unit === 'lb' || remote.unit === 'lb') ? 'lb' : 'kg'
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
// 录入时间（时:分），用于区分同日多条记录
function fmtTime(t) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const todayStr = () => fmtDate(new Date())

/* ---------- 存储工具（localStorage 优先，Cookie 兜底身份键） ---------- */
// 部分移动端环境（无痕模式 / App 内置 WebView）localStorage 写入会被静默拒绝，
// 导致昵称"看似设置成功、下次打开丢失"。身份键（UID）双写 localStorage + Cookie：
// 任一介质成功即可在下次打开时恢复身份，随后从云端拉回数据；全部失败时向 UI 暴露信号。
const UID_COOKIE = 'wt_uid'
let lastPersisted = true // 最近一次 setUserId 是否至少有一个介质写入成功

function lsGet(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return localStorage.getItem(k) === v } catch (e) { return false } }
function lsDel(k) { try { localStorage.removeItem(k) } catch (e) { /* ignore */ } }
function cookieGet(k) {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + k + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : ''
}
function cookieSet(k, v) {
  try {
    document.cookie = `${k}=${encodeURIComponent(v)}; max-age=31536000; path=/; SameSite=Lax`
    return cookieGet(k) === v
  } catch (e) { return false }
}
function cookieDel(k) { try { document.cookie = `${k}=; max-age=0; path=/` } catch (e) { /* ignore */ } }

// 最近一次昵称写入是否至少有一个介质成功持久化（供 UI 提示用户）
export function uidPersisted() { return lastPersisted }

/* ---------- 云端基准版本与脏标记（并发写保护 + 断网补推） ---------- */
let baseSha = '' // 最近一次成功读取/写入的远端文件版本 sha，作为乐观并发写入基准
export function setBaseSha(sha) { baseSha = sha || '' }
export function getBaseSha() { return baseSha }
// 脏标记：本地有改动但尚未成功推送到云端时为 '1'；网络恢复/回到前台时自动重推
function isDirty() {
  try { return localStorage.getItem(DIRTY_KEY) === '1' } catch (e) { return false }
}
function setDirty(v) {
  try { v ? localStorage.setItem(DIRTY_KEY, '1') : localStorage.removeItem(DIRTY_KEY) } catch (e) { /* ignore */ }
}

/* ---------- 用户身份 ---------- */
export function getUserId() {
  return lsGet(UID_KEY) || cookieGet(UID_COOKIE) || ''
}
export function setUserId(uid) {
  const safe = String(uid || '').trim().slice(0, 40).replace(/[\\/:*?"<>|#%{}\s]/g, '')
  if (safe) {
    const okL = lsSet(UID_KEY, safe)
    const okC = cookieSet(UID_COOKIE, safe)
    lastPersisted = okL || okC
  } else {
    lsDel(UID_KEY)
    cookieDel(UID_COOKIE)
    lastPersisted = true
  }
  return safe
}
// 切换当前用户：写入身份 → 重载该用户的本地数据
// 旧数据（本机旧共享键 / 线上旧公开 data.json）只有本机「第一个设置昵称的用户」允许继承一次；
// 改名或清除后重设昵称时本地数据从零开始，云端文件同样只写入该用户自己的数据。
export function switchUser(uid) {
  const prev = getUserId()
  const safe = setUserId(uid)
  if (!prev && !!safe && !firstUser()) {
    // 本机首次设置昵称：固定记录为首用户，之后任何昵称（含清除后重设）都不再继承旧数据
    try { localStorage.setItem(FIRST_USER_KEY, safe) } catch (e) { /* ignore */ }
  }
  const data = loadLocal(!prev && !!safe)
  baseSha = '' // 切换用户后旧基准失效，下次 push 会自动拉远端合并后再写，不覆盖他人数据
  state.records = data.records
  state.goal = data.goal
  state.height = data.height
  state.unit = data.unit || 'kg'
  return safe
}

/* ---------- 本地存取（按用户分键，兼容旧键迁移） ---------- */
function localKey() {
  const uid = getUserId()
  return uid ? `${LS_KEY}:${uid}` : LS_KEY
}
function firstUser() {
  try { return localStorage.getItem(FIRST_USER_KEY) || '' } catch (e) { return '' }
}
function loadLocal(allowLegacy) {
  let raw = null
  try { raw = localStorage.getItem(localKey()) } catch (e) { /* ignore */ }
  if (!raw && getUserId() && allowLegacy) {
    // 本机首次设置昵称：将旧版共享数据搬移到该用户键，并删除旧键确保旧数据只继承一次
    try {
      raw = localStorage.getItem(LS_KEY)
      if (raw) {
        localStorage.setItem(localKey(), raw)
        localStorage.removeItem(LS_KEY)
      }
    } catch (e) { /* ignore */ }
  }
  if (raw) {
    try { return normalize(JSON.parse(raw)) } catch (e) { /* ignore */ }
  }
  return { records: [], goal: null, height: null, unit: 'kg' }
}
function saveLocal() {
  try { localStorage.setItem(localKey(), JSON.stringify({ records: state.records, goal: state.goal, height: state.height, unit: state.unit })) } catch (e) { /* ignore */ }
}

/* ---------- 响应式状态 ---------- */
const state = reactive({
  ...loadLocal(),
  syncState: 'idle', // idle | syncing | ok | local | error
  syncMsg: ''
})

export const store = state

/* ---------- 单位换算（仅展示，存储始终为 kg） ---------- */
const LB_PER_KG = 2.2046226218
export const unitLabel = computed(() => (state.unit === 'lb' ? 'lb' : 'kg'))
// kg 值 → 按当前显示单位换算后的数值，仅用于展示
export function dispKg(v) {
  return state.unit === 'lb' ? v * LB_PER_KG : v
}
const fmtKg = (v) => `${dispKg(v).toFixed(1)} ${unitLabel.value}`

export const stats = computed(() => {
  const sorted = sortRecs(state.records)
  if (!sorted.length) return { empty: true, cards: [] }
const last = sorted[sorted.length - 1]
  // 「较上次」以上一个不同日期的记录为基准：同一天多次记录不参与比较，
  // 避免把早/晚两次测量差误读为「变化」；仅一天数据时 prev 为 null 且不显示该卡片
  let prev = null
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i].date !== last.date) { prev = sorted[i]; break }
  }
  const first = sorted[0]

  const avgBetween = (startStr) => {
    const list = sorted.filter((r) => r.date >= startStr)
    if (!list.length) return null
    return list.reduce((s, r) => s + r.weight, 0) / list.length
  }
const fmtDiff = (d) => {
    if (d === null || d === undefined || !isFinite(d)) return '--'
    const sign = d > 0 ? '+' : ''
    return `${sign}${dispKg(d).toFixed(1)} ${unitLabel.value}`
  }

  const d6 = new Date(); d6.setDate(d6.getDate() - 6)
  const d29 = new Date(); d29.setDate(d29.getDate() - 29)
  const avg7 = avgBetween(fmtDate(d6))
  const avg30 = avgBetween(fmtDate(d29))
  const ws = sorted.map((r) => r.weight)
  const maxW = Math.max(...ws)
  const minW = Math.min(...ws)

const cards = []
  cards.push({ label: '当前体重', value: fmtKg(last.weight), hint: `更新于 ${last.date.slice(5)}${last.ts != null ? ' ' + fmtTime(last.ts) : ''}` })
  if (prev) {
    const dLast = last.weight - prev.weight
    cards.push({
      label: '较上次变化', value: fmtDiff(dLast), hint: `上次 ${prev.date.slice(5)}${prev.ts != null ? ' ' + fmtTime(prev.ts) : ''}`,
      cls: dLast > 0 ? 'up' : dLast < 0 ? 'down' : ''
    })
  }
  const dStart = last.weight - first.weight
  cards.push({
    label: '较起始变化', value: fmtDiff(dStart), hint: `起始 ${first.date.slice(5)}`,
    cls: dStart > 0 ? 'up' : dStart < 0 ? 'down' : ''
  })
  if (avg7 !== null) cards.push({ label: '近 7 天均值', value: fmtKg(avg7) })
  if (avg30 !== null) cards.push({ label: '近 30 天均值', value: fmtKg(avg30) })
  cards.push({ label: '最高 / 最低', value: `${fmtKg(maxW)} / ${fmtKg(minW)}` })
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
        ? { label: '距目标', value: fmtKg(left), hint: `目标 ${fmtKg(state.goal)}，还需减重`, cls: 'up' }
        : { label: '距目标', value: '达成', hint: `目标 ${fmtKg(state.goal)} 已达成`, cls: 'ok' }
    )
  }
  return { empty: false, cards, sorted }
})

/* ---------- 减肥进度 ---------- */
// 达标时间预估：对全部记录做最小二乘线性回归（x=距离首条的天数, y=体重kg），
// 用当前斜率外推还需减/增多少天可达目标；斜率方向不对（在往反方向走）或样本过少时返回 null。
const DAY_MS = 86400000
function estimateEta(records, start, cur, goal, direction) {
  if (records.length < 3) return null
  const sorted = sortRecs(records)
  const t0 = new Date(sorted[0].date + 'T00:00:00').getTime()
  let sx = 0, sy = 0, sxy = 0, sxx = 0, n = 0
  for (const r of sorted) {
    const x = (new Date(r.date + 'T00:00:00').getTime() - t0) / DAY_MS
    if (!isFinite(x)) continue
    const y = r.weight
    sx += x; sy += y; sxy += x * y; sxx += x * x; n++
  }
  if (n < 2) return null
  const denom = n * sxx - sx * sx
  if (!denom) return null
  const slope = (n * sxy - sx * sy) / denom // kg/天
  if (!isFinite(slope) || Math.abs(slope) < 0.001) return null
  // 斜率方向必须与目标方向一致：减重需 slope<0，增重需 slope>0
  if (direction === 'lose' && slope >= 0) return null
  if (direction === 'gain' && slope <= 0) return null
  const need = direction === 'lose' ? cur - goal : goal - cur
  if (need <= 0) return null
  const days = Math.ceil(need / Math.abs(slope))
  if (days > 36500) return null // 过于久远视为不可预估
  const last = new Date(sorted[sorted.length - 1].date + 'T00:00:00')
  last.setDate(last.getDate() + days)
  return { days, date: fmtDate(last) }
}

export const progress = computed(() => {
  const sorted = sortRecs(state.records)
  if (!sorted.length) return { empty: true, hasGoal: !!state.goal, goal: state.goal, cur: null, start: null, pct: 0, done: 0, need: 0, reached: false, direction: 'keep', eta: null }
  const start = sorted[0].weight
  const cur = sorted[sorted.length - 1].weight
  const goal = state.goal
  if (goal === null) {
    return { empty: false, hasGoal: false, goal: null, cur, start, pct: 0, done: start - cur, need: 0, reached: false, direction: 'keep', eta: null }
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
  const eta = reached ? null : estimateEta(sorted, start, cur, goal, direction)
  return { empty: false, hasGoal: true, goal, cur, start, pct, done, need: Math.max(0, total - Math.abs(done)), reached, direction, eta }
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
    case 'error': return isDirty() ? '本地已存待重推' : '同步失败'
    case 'local': return '本地模式'
    default: return '同步'
  }
})

function fetchRemote() {
  const uid = getUserId()
  if (!uid) return Promise.resolve(null)
  return fetch(userApi(uid), { headers: proxyHeaders() })
    .then((res) => {
      if (!res.ok) {
        return res.json().catch(() => null).then((er) => { throw new Error(why(res, er)) })
      }
      return res.json()
    })
    .then((j) => {
      // Worker 约定：文件不存在时返回 { exists:false, records:[], goal:null, height:null }
      if (!j || !j.exists) return null
      // sha 为该文件当前版本（乐观并发基准），供并发写保护使用
      return { records: j.records || [], goal: j.goal ?? null, height: j.height ?? null, unit: j.unit || 'kg', sha: j.sha || '' }
    })
}

const why = (res, er) => {
  const msg = (er && (er.error || er.message)) || `HTTP ${res.status}`
  if (res.status === 403) return 'HTTP 403：代理拒绝访问（站点密钥 SITE_KEY 不匹配，或 Worker 未部署）'
  if (res.status === 502) return 'HTTP 502：GitHub 服务暂不可用，请稍后重试'
  if (/rate/i.test(msg)) return 'HTTP 403：GitHub API 限流，请稍后重试'
  if (/not found/i.test(msg)) return 'HTTP 404：私有数据仓库或用户文件不存在'
  return msg
}

export function pushRemote() {
  const uid = getUserId()
  if (!uid) {
    setSyncState('local', '未设置用户昵称，数据仅保存在本机')
    return Promise.resolve(false)
  }
  if (!proxyReady()) {
    setSyncState('local', '云同步未就绪：请先部署 Worker 并填入代理地址（数据已存本地）')
    return Promise.resolve(false)
  }
  setSyncState('syncing', '正在同步…')
  // 先探测远端文件：不存在且是本机首个用户时，合并旧版公开 data.json 保证历史迁移不丢；
  // 已存在且本地基准缺失/过期时先合并远端再写，避免覆盖其他设备的写入（并发写保护）
  return fetch(userApi(uid), { headers: proxyHeaders(), cache: 'no-store' })
    .then((res) => {
      if (!res.ok) return res.json().catch(() => null).then((er) => { throw new Error(why(res, er)) })
      return res.json()
    })
    .then((j) => {
      let payload = { records: state.records, goal: state.goal, height: state.height, unit: state.unit }
      if (!j || !j.exists) {
        if (uid === firstUser()) {
          return fetch(CFG.legacyRaw, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null)
            .then((legacy) => (legacy ? mergeData(payload, normalize(legacy)) : payload))
        }
        return payload
      }
      if (j.sha && (!baseSha || baseSha !== j.sha)) {
        // 基准版本缺失或过期：把远端数据合并进本次写入，任何一端的数据都不丢
        payload = mergeData(payload, normalize(j))
        baseSha = j.sha
      }
      return payload
    })
    .then((payload) => {
      let attempt = 0
      let conflicted = false // 409 只合并重试一次，避免死循环
      const doPut = () => {
        const headers = { ...proxyHeaders(), 'Content-Type': 'application/json' }
        if (baseSha) headers['X-Base-Sha'] = baseSha
        return fetch(userApi(uid), { method: 'PUT', headers, body: JSON.stringify(payload) })
          .then((res) => {
            if (res.status === 409 && !conflicted) {
              // 即将写入瞬间远端又被其他设备改动：拉最新 → 合并 → 换新基准重推一次
              conflicted = true
              setSyncState('syncing', '检测到其他设备已更新，合并后重推…')
              return fetch(userApi(uid), { headers: proxyHeaders(), cache: 'no-store' })
                .then((r2) => (r2.ok ? r2.json() : null))
                .then((latest) => {
                  if (latest && latest.exists && latest.sha) {
                    payload = mergeData(payload, normalize(latest))
                    baseSha = latest.sha
                  }
                  return doPut()
                })
            }
            if (res.status >= 500 && attempt < 3) {
              attempt++
              setSyncState('syncing', `服务器繁忙（HTTP ${res.status}），第 ${attempt}/3 次重试…`)
              return new Promise((r) => setTimeout(r, 1500 * attempt)).then(doPut)
            }
            return res
          })
      }
      return doPut()
    })
    .then((res) => {
      if (!res.ok) {
        return res.json().catch(() => null).then((er) => { throw new Error(why(res, er)) })
      }
      return res.json()
    })
    .then((j) => {
      if (j && j.sha) baseSha = j.sha // 以刚写入的远端版本作为新基准
      setDirty(false)
      setSyncState('ok', `已同步上线 · ${todayStr()}`)
      return true
    })
    .catch((e) => {
      // 未成功同步：数据已保存本地，置脏标记；联网/回到前台自动重推，不丢数据
      setDirty(true)
      setSyncState('error', `本地已保存，联网后自动重推（${e.message}）`)
      return false
    })
}

export function pullAndMerge() {
  if (!getUserId()) {
    setSyncState('local', '未设置用户昵称，先在顶部设置昵称即可云端隔离存储')
    return
  }
  if (!proxyReady()) {
    setSyncState('local', '云同步未就绪：请部署 Cloudflare Worker 后自动开启（数据保存在本机）')
    return
  }
  fetchRemote()
    .then((remote) => {
      if (remote === null) {
        const dirty = state.records.length > 0
        setSyncState(dirty ? 'local' : 'ok', dirty ? '线上暂无数据，本地有内容待上传' : '线上暂无数据')
        if (dirty) pushRemote()
        return
      }
      setBaseSha(remote.sha) // 记录远端版本，供本次后续写入作为并发基准
      const rn = normalize(remote)
      const merged = mergeData({ records: state.records, goal: state.goal, height: state.height, unit: state.unit }, rn)
      const changed = !dataEq(merged, { records: state.records, goal: state.goal, height: state.height, unit: state.unit })
      state.records = merged.records
      state.goal = merged.goal
      state.height = merged.height
      state.unit = merged.unit || 'kg'
      saveLocal()
      const localExtra = state.records.length > rn.records.length
      if (changed || localExtra || ((state.goal || state.height) && !rn.goal && !rn.height)) {
        pushRemote()
      } else {
        setDirty(false) // 本地与线上一致，无残留改动
        setSyncState('ok', `已从线上载入 ${rn.records.length} 条记录`)
      }
    })
    .catch((e) => {
      setSyncState('local', `线上读取失败，使用本地数据（${e.message}）`)
    })
}

/* ---------- 业务操作 ---------- */
// 新增记录：总是追加，同一日期可有多条，按录入时间区分先后
export function addRecord(date, weight, note) {
  state.records.push({ id: genId(), date, weight, note, ts: Date.now() })
  saveLocal()
  pushRemote()
}

// 编辑单条记录：按 id 定位更新（date/weight/note 均可改）
export function updateRecord(id, patch) {
  const r = state.records.find((x) => x.id === id)
  if (!r) return
  if (patch && typeof patch.date === 'string' && DATE_RE.test(patch.date)) r.date = patch.date
  if (patch && typeof patch.weight === 'number' && isFinite(patch.weight)) r.weight = patch.weight
  if (patch && typeof patch.note === 'string') r.note = patch.note
  saveLocal()
  pushRemote()
}

// 删除单条记录（按 id），不再整日删除
export function deleteRecord(id) {
  state.records = state.records.filter((r) => r.id !== id)
  saveLocal()
  pushRemote()
}

export function saveSettings(goal, height, unit) {
  state.goal = goal
  state.height = height
  if (unit === 'kg' || unit === 'lb') state.unit = unit
  saveLocal()
  pushRemote()
}

export function exportData() {
  const recs = sortRecs(state.records) // 按日期升序导出，便于阅读
  if (!recs.length) return false // 无记录不生成空文件
  const headers = ['日期', '时间', '体重(kg)', '备注']
  const rows = recs.map((r) => [
    r.date,
    r.ts != null ? fmtTime(r.ts) : '',
    r.weight,
    r.note || ''
  ])
  const buf = buildXlsx({ sheetName: '体重记录', headers, rows })
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `weight-tracker-${todayStr()}.xlsx`
  a.click()
  URL.revokeObjectURL(a.href)
  return true
}

/* ---------- 断网恢复自动补推 ---------- */
// 同步失败时数据已保存在本地（脏标记置位）；网络恢复或页面回到前台时自动重推，
// 避免断网期间的改动一直滞留本机；推成功或本地无改动时自动清除脏标记。
function autoPush() {
  if (isDirty() && getUserId() && proxyReady() && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    pushRemote()
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', autoPush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') autoPush()
  })
}