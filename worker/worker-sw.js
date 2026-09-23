// ============================================================
// weight-tracker 数据代理（Cloudflare Worker）
// ------------------------------------------------------------
// 作用：前端永远看不到 GitHub Token，读写私有数据仓库
//       weight-tracker-data 的全部请求都经由此代理完成。
//
// 鉴权（唯一路径）：GitHub App（installation token 动态换取，永不过期）
//   GH_APP_ID             : GitHub App ID（整数）
//   GH_APP_INSTALLATION_ID: App 安装 ID（整数）
//   GH_APP_PRIVATE_KEY    : App 私钥（PKCS8 PEM 全文，作为 Secret）
//   Worker 用私钥签 JWT → 换取 installation token（1h 有效）→ 缓存至过期前 1 分钟
//
// 需要配置的环境变量（Settings -> Variables and Secrets）：
//   SITE_KEY (Secret) : 站点密钥，与前端内置值一致，防止代理被陌生人调用
//   GH_OWNER (Text)   : GitHub 用户名，如 tan17ocean
//   GH_REPO  (Text)   : 私有数据仓库名，如 weight-tracker-data
//   GH_APP_ID (Text)  : GitHub App ID
//   GH_APP_INSTALLATION_ID (Text) : GitHub App 安装 ID
//   GH_APP_PRIVATE_KEY (Secret)   : GitHub App 私钥（PKCS8 PEM）
//
// 接口：
//   GET  /users/<uid>.json 读取用户数据
//   PUT  /users/<uid>.json 写入用户数据
//   GET  /health           健康检查（鉴权方式、token 有效期、GitHub 连通性）
// ============================================================

const GH_API = 'https://api.github.com'

// ---------- 基础工具 ----------
function b64encode(str) {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary)
}

function b64decode(b64) {
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function b64urlFromBytes(bytes) {
  let binary = ''
  new Uint8Array(bytes).forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...(headers || {}), 'Content-Type': 'application/json; charset=utf-8' }
  })
}

// ---------- GitHub App 鉴权 ----------
let cachedToken = null        // 当前 installation token
let cachedExpiresAt = 0       // token 过期时间（毫秒），提前 1 分钟视为过期
let inflight = null           // 正在获取 token 的 Promise（并发去重）

function appAuthConfigured() {
  return !!(globalThis.GH_APP_ID && globalThis.GH_APP_INSTALLATION_ID && globalThis.GH_APP_PRIVATE_KEY)
}

async function signJwt() {
  const pem = globalThis.GH_APP_PRIVATE_KEY
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlFromBytes(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = b64urlFromBytes(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 600, iss: String(globalThis.GH_APP_ID) })))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64urlFromBytes(sig)}`
}

async function fetchInstallToken() {
  const jwt = await signJwt()
  const res = await fetch(`${GH_API}/app/installations/${globalThis.GH_APP_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'weight-tracker-worker'
    }
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(`gh app auth: ${res.status} ${j.message || ''}`)
    err.isAuthError = res.status >= 400 && res.status < 500
    throw err
  }
  cachedToken = j.token
  cachedExpiresAt = new Date(j.expires_at).getTime() - 60000 // 提前 1 分钟刷新
  return cachedToken
}

async function getInstallToken() {
  if (cachedToken && Date.now() < cachedExpiresAt) return cachedToken
  if (inflight) return inflight
  inflight = fetchInstallToken().finally(() => { inflight = null })
  return inflight
}

// 获取 GitHub 请求头：仅使用 GitHub App installation token（旧 GH_TOKEN 兜底已移除）
async function getGhHeaders() {
  if (!appAuthConfigured()) {
    throw new Error('github app auth not configured (GH_APP_ID / GH_APP_INSTALLATION_ID / GH_APP_PRIVATE_KEY)')
  }
  const t = await getInstallToken()
  return {
    Authorization: `Bearer ${t}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'weight-tracker-worker'
  }
}

// 当前实际生效的鉴权方式（供 /health 与错误信息使用）
function authKind() {
  return appAuthConfigured() ? 'github-app' : 'none'
}

// ---------- 路由处理 ----------
async function handleRequest(request) {
    const url = new URL(request.url)

    // ---------- CORS 预检 ----------
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Site-Key, X-Base-Sha',
      'Access-Control-Max-Age': '86400'
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    // ---------- 站点密钥校验（防陌生人直接调用代理） ----------
    const siteKey = request.headers.get('X-Site-Key')
    if (!globalThis.SITE_KEY || siteKey !== globalThis.SITE_KEY) {
      return json({ error: 'invalid site key' }, 403, corsHeaders)
    }

    // ---------- /health 健康检查 ----------
    if (url.pathname === '/health' && request.method === 'GET') {
      let ghOk = null
      let probeMsg = ''
      let tokenExpiresAt = null
      let authError = null
      try {
        const h = await getGhHeaders()
        const probe = await fetch(`${GH_API}/rate_limit`, { headers: h })
        ghOk = probe.ok
        if (!probe.ok) probeMsg = `github probe ${probe.status}`
        if (cachedExpiresAt) tokenExpiresAt = new Date(cachedExpiresAt + 60000).toISOString()
      } catch (e) {
        ghOk = false
        authError = e.message
      }
      return json({
        ok: ghOk,
        service: 'weight-tracker-proxy',
        auth: authKind(),
        appId: globalThis.GH_APP_ID ? Number(globalThis.GH_APP_ID) : null,
        installationId: globalThis.GH_APP_INSTALLATION_ID ? Number(globalThis.GH_APP_INSTALLATION_ID) : null,
        tokenExpiresAt,
        github: ghOk,
        authError,
        note: probeMsg || undefined,
        ts: new Date().toISOString()
      }, ghOk === false ? 502 : 200, corsHeaders)
    }

    // ---------- 路由：/users/<uid>.json ----------
    const m = url.pathname.match(/^\/users\/([^/]+)\.json$/)
    if (!m) return json({ error: 'bad path' }, 404, corsHeaders)
    const uid = decodeURIComponent(m[1])
    if (!uid) return json({ error: 'empty uid' }, 400, corsHeaders)

    const owner = globalThis.GH_OWNER || 'tan17ocean'
    const repo = globalThis.GH_REPO || 'weight-tracker-data'
    const path = `data/users/${encodeURIComponent(uid)}.json`
    const contentsUrl = `${GH_API}/repos/${owner}/${repo}/contents/${path}`

    // 获取鉴权头（GitHub App installation token）
    let ghHeaders
    try {
      ghHeaders = await getGhHeaders()
    } catch (e) {
      return json({ error: e.message || 'github auth unavailable', code: e.isAuthError ? 'AUTH' : 'NET' }, 502, corsHeaders)
    }

    // ---------- GET：读取该用户数据 ----------
    if (request.method === 'GET') {
      const res = await fetch(contentsUrl, { headers: ghHeaders })
      if (res.status === 404) {
        return json({ exists: false, records: [], goal: null, height: null }, 200, corsHeaders)
      }
      if (!res.ok) {
        return json({ error: `github read ${res.status}`, code: res.status === 401 || res.status === 403 ? 'AUTH' : 'GH' }, 502, corsHeaders)
      }
      const j = await res.json()
      let data
      try { data = JSON.parse(b64decode(j.content)) } catch (e) { data = {} }
      return json({ ...data, exists: true, sha: j.sha }, 200, corsHeaders)
    }

    // ---------- PUT：写入该用户数据（自动处理 sha 覆盖） ----------
    if (request.method === 'PUT') {
      let body
      try { body = await request.json() } catch (e) { body = {} }

      // 乐观并发：客户端声明写入所基于的远端版本（X-Base-Sha）
      const baseSha = request.headers.get('X-Base-Sha') || ''

      // 取当前文件 sha
      let sha = null
      const cur = await fetch(contentsUrl, { headers: ghHeaders })
      if (cur.status === 404) {
        sha = null
      } else if (cur.ok) {
        const cj = await cur.json()
        sha = cj.sha
      } else {
        return json({ error: `github read ${cur.status}`, code: cur.status === 401 || cur.status === 403 ? 'AUTH' : 'GH' }, 502, corsHeaders)
      }

      // 远端文件已被他人修改且客户端声明了基准版本 → 409，客户端重新拉取合并后再写
      if (baseSha && sha && baseSha !== sha) {
        return json({ error: 'conflict', sha }, 409, corsHeaders)
      }

      const payload = JSON.stringify(
        { records: Array.isArray(body.records) ? body.records : [], goal: body.goal ?? null, height: body.height ?? null },
        null, 2
      )
      const putBody = {
        message: `update weight data ${new Date().toISOString().slice(0, 10)}`,
        content: b64encode(payload)
      }
      if (sha) putBody.sha = sha

      const res = await fetch(contentsUrl, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(putBody)
      })
      if (!res.ok) {
        const ej = await res.json().catch(() => ({}))
        return json({ error: ej.message || `github write ${res.status}`, code: res.status === 401 || res.status === 403 ? 'AUTH' : 'GH' }, 502, corsHeaders)
      }
      const rj = await res.json()
      return json({ ok: true, sha: rj.content && rj.content.sha }, 200, corsHeaders)
    }

    return json({ error: 'method not allowed' }, 405, corsHeaders)
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request))
})