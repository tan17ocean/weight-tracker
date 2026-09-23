# 体重记录站 · Cloudflare Worker 代理部署指引（GitHub App 版）

## 为什么需要这一步

为了让**每个访问网页的用户都能自动同步数据，且看不到 GitHub Token 明文**，
前端不再直接携带 Token，而是改经一个 Cloudflare Worker 代理读写私有数据仓库
`weight-tracker-data`。凭据只存放在 Worker 的服务端环境变量（Secret）中，
网页只和 Worker 通信，**任何访客（包括查看源码/开发者工具的用户）都看不到凭据**。

本方案使用 **GitHub App（App Installation Token 动态换取）** 作为唯一鉴权方式，
不再使用任何 PAT（Personal Access Token），因此不存在 90 天过期、吊销或泄露问题。

---

## 架构总览

```
浏览器前端（GitHub Pages）
   │  GET/PUT https://weight-tracker-proxy.<子域>.workers.dev/users/<uid>.json
   │  携带 X-Site-Key（防滥用）、X-Base-Sha（乐观锁，PUT 时携带）
   ▼
Cloudflare Worker（weight-tracker-proxy）
   │  用 GitHub App 私钥签 JWT → 换取 installation token（1h，缓存至过期前）
   ▼
GitHub 私有仓库 tan17ocean/weight-tracker-data 的 data/users/<uid>.json
```

- **SITE_KEY**：防陌生人调用代理的站点密钥（前端内置，仅防滥用，不含敏感信息）。
- **X-Base-Sha**：客户端声明本次写入基于的远端文件版本；
  若远端已被修改（sha 不一致），Worker 返回 `409 conflict`，前端自动重新拉取合并后重试。

---

## 1. 已创建的资源清单（本次部署完成）

| 资源 | 值 |
| --- | --- |
| Cloudflare Worker 名称 | `weight-tracker-proxy` |
| Worker 域名 | `https://weight-tracker-proxy.1515618169.workers.dev` |
| GitHub App | `weight-tracker-sync-app`，App ID `5040273` |
| GitHub App Installation | `163921510`（只授权 `weight-tracker-data` 仓库，Contents 读写） |
| 数据仓库 | `tan17ocean/weight-tracker-data`（私有） |

## 2. Worker 环境变量（Settings -> Variables and Secrets）

| 变量名 | 类型 | 值 |
| --- | --- | --- |
| `SITE_KEY` | Secret | `wtsk-891daa4c581a01097189e6a1`（与前端内置值一致，勿改） |
| `GH_APP_ID` | Text | `5040273` |
| `GH_APP_INSTALLATION_ID` | Text | `163921510` |
| `GH_OWNER` | Text | `tan17ocean` |
| `GH_REPO` | Text | `weight-tracker-data` |
| `GH_APP_PRIVATE_KEY` | Secret | GitHub App 私钥（PKCS8 PEM 全文，来自 Settings -> Developer settings -> GitHub Apps -> Generate a private key） |

> 注意：**不需要、也不要配置 `GH_TOKEN`**。旧方案遗留的 GH_TOKEN 应删除，
> 旧的 PAT 应到 GitHub 设置里吊销。

## 3. 部署（更新 Worker 代码）

在 Cloudflare Dashboard 打开该 Worker -> **Edit code**，把本工程
`worker/worker-sw.js` 的**全部内容**覆盖粘贴到编辑器，点击 **Deploy** 保存。

> 说明：通过 PUT 上传脚本时，文本变量（GH_APP_ID / GH_APP_INSTALLATION_ID /
> GH_OWNER / GH_REPO）会被清空，只有 Secret 保留；因此**每次上传代码后都要重新
> 添加这 4 个 Text 变量**（Settings -> Variables and Secrets -> Edit -> Add variable）
> 再 Deploy。更稳妥的做法：在编辑页右侧 Settings 里添加变量，或直接在
> Variables and Secrets 页面修改后保存。

## 4. 前端同步（无需额外配置）

前端 `web/src/store.js` 已内置代理地址与 SITE_KEY，构建部署后自动云端同步。
若代理域名变更，只需修改 `CFG.proxy` 后重新构建部署前端。

---

## 验证清单（部署后检查）

- [ ] `https://weight-tracker-proxy.1515618169.workers.dev/health`
      请求时携带 `X-Site-Key` 头，返回 `auth:"github-app"`、`github:true`
- [ ] GET `/users/<uid>.json` 读取正常（无文件时返回 `exists:false`）
- [ ] PUT 携带 `X-Base-Sha` 写入正常；用过期 sha 写入返回 `409 conflict`
- [ ] 环境变量中**没有** `GH_TOKEN`；旧 PAT 已在 GitHub 吊销