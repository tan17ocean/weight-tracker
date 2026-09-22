// ============================================================
// weight-tracker 数据代理（Cloudflare Worker）
// ------------------------------------------------------------
// 作用：前端永远看不到 GitHub Token，读写私有数据仓库
//       weight-tracker-data 的全部请求都经由此代理完成。
// Token 只存放在 Worker 环境变量 GH_TOKEN（作为 Secret）。
//
// 需要配置的环境变量（Settings -> Variables and Secrets）：
//   GH_TOKEN (Secret) : GitHub fine-grained token（仅授权
//                       weight-tracker-data，Contents: Read and write）
//   SITE_KEY (Secret) : 站点密钥，与前端内置值一致，防止代理被陌生人调用
//   GH_OWNER (Text)   : GitHub 用户名，如 tan17ocean
//   GH_REPO  (Text)   : 私有数据仓库名，如 weight-tracker-data
// ============================================================

const GH_API = 'https://api.github.com'

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

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...(headers || {}), 'Content-Type': 'application/json; charset=utf-8' }
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // ---------- CORS 预检 ----------
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Site-Key',
      'Access-Control-Max-Age': '86400'
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    // ---------- 站点密钥校验（防陌生人直接调用代理） ----------
    const siteKey = request.headers.get('X-Site-Key')
    if (!env.SITE_KEY || siteKey !== env.SITE_KEY) {
      return json({ error: 'invalid site key' }, 403, corsHeaders)
    }

    // ---------- 路由：/users/<uid>.json ----------
    const m = url.pathname.match(/^\/users\/([^/]+)\.json$/)
    if (!m) return json({ error: 'bad path' }, 404, corsHeaders)
    const uid = decodeURIComponent(m[1])
    if (!uid) return json({ error: 'empty uid' }, 400, corsHeaders)

    const owner = env.GH_OWNER || 'tan17ocean'
    const repo = env.GH_REPO || 'weight-tracker-data'
    const path = `data/users/${encodeURIComponent(uid)}.json`
    const contentsUrl = `${GH_API}/repos/${owner}/${repo}/contents/${path}`

    const ghHeaders = {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'weight-tracker-worker'
    }

    // ---------- GET：读取该用户数据 ----------
    if (request.method === 'GET') {
      const res = await fetch(contentsUrl, { headers: ghHeaders })
      if (res.status === 404) {
        return json({ exists: false, records: [], goal: null, height: null }, 200, corsHeaders)
      }
      if (!res.ok) {
        return json({ error: `github read ${res.status}` }, 502, corsHeaders)
      }
      const j = await res.json()
      let data
      try { data = JSON.parse(b64decode(j.content)) } catch (e) { data = {} }
      return json({ ...data, exists: true }, 200, corsHeaders)
    }

    // ---------- PUT：写入该用户数据（自动处理 sha 覆盖） ----------
    if (request.method === 'PUT') {
      let body
      try { body = await request.json() } catch (e) { body = {} }

      // 取当前文件 sha
      let sha = null
      const cur = await fetch(contentsUrl, { headers: ghHeaders })
      if (cur.status === 404) {
        sha = null
      } else if (cur.ok) {
        const cj = await cur.json()
        sha = cj.sha
      } else {
        return json({ error: `github read ${cur.status}` }, 502, corsHeaders)
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
        return json({ error: ej.message || `github write ${res.status}` }, 502, corsHeaders)
      }
      const rj = await res.json()
      return json({ ok: true, sha: rj.content && rj.content.sha }, 200, corsHeaders)
    }

    return json({ error: 'method not allowed' }, 405, corsHeaders)
  }
}