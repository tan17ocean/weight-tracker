# 体重记录站 · Cloudflare Worker 代理部署指引

## 为什么需要这一步

为了让**每个访问网页的用户都能自动同步数据，且看不到 GitHub Token 明文**，
前端不再直接携带 Token，而是改经一个 Cloudflare Worker 代理读写私有数据仓库
`weight-tracker-data`。Token 只存放在 Worker 的服务端环境变量（Secret）中，
网页只和 Worker 通信，**任何访客（包括查看源码/开发者工具的用户）都看不到 Token**。

你需要完成以下四个配置动作，然后告诉我 Worker 的域名，我再把地址填入前端并重新部署。

---

## 1. 创建 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)（没有账号先免费注册一个）。
2. 左侧菜单进入 **Workers & Pages** → **Create application** → **Worker**：
   - Name（名称）：`weight-tracker-proxy`（可自定义）
   - 点击 **Deploy** 创建。
3. 创建后进入该 Worker → **Edit code**，把本工程 `worker/worker.js` 的**全部内容**
   覆盖粘贴到编辑器中，点击右上角 **Deploy** 保存。

## 2. 配置环境变量（关键！）

进入 Worker → **Settings** → **Variables and Secrets**，添加以下 4 项：

| 变量名      | 类型   | 值                                                         |
| ----------- | ------ | ---------------------------------------------------------- |
| `GH_TOKEN`  | Secret | GitHub Token（见下方第 3 步，建议为 Fine-grained Token）   |
| `SITE_KEY`  | Secret | `wtsk-891daa4c581a01097189e6a1`（与前端内置值一致，勿改）  |
| `GH_OWNER`  | Text   | `tan17ocean`                                               |
| `GH_REPO`   | Text   | `weight-tracker-data`（私有数据仓库名，勿改）              |

> SITE_KEY 仅用于防止代理被无关的人乱调用（防滥用），它不含任何 Token 敏感信息；
> Token 只存在于 GH_TOKEN 环境变量中，前端拿不到。

## 3. 生成一个最小权限的 GitHub Token

**强烈建议不要继续使用总 Token `ghp_...`（它的权限太大），为此站单独生成一个
Fine-grained Token，只授权数据仓库：**

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token。
2. 填名称（如 `weight-tracker-worker`）、过期时间。
3. **Repository access** 选择 **Only select repositories** → 勾选 `weight-tracker-data`（私有数据仓库）。
4. **Permissions** → `Contents` 设为 **Read and write**（这是唯一需要的权限）。
5. 生成后复制 `github_pat_...` 开头的 Token → 粘贴到 Worker 的 `GH_TOKEN` 环境变量。

> 重要：这个 Token 只写在 Cloudflare Worker 的 Secret 里，不要发给任何访客；
> 若之前创建过旧的总 Token（`ghp_` 开头的 Personal access token），请到 GitHub 设置里撤销吊销。

## 4. 把 Worker 域名发给我

Worker 部署后，在 **Workers & Pages** → 你的 Worker 页面顶部能看到域名，形如：

```
https://weight-tracker-proxy.<你的子域>.workers.dev
```

把这个地址告诉我，我会：
1. 填入前端 `web/src/store.js` 的 `CFG.proxy`；
2. 重新构建并部署前端到 GitHub Pages；
3. 验证同步可用后交付。

---

## 验证清单（部署后自行检查）

- [ ] Worker 编辑器中已粘贴 `worker/worker.js` 并 Deploy
- [ ] 四个环境变量都已添加（GH_TOKEN / SITE_KEY / GH_OWNER / GH_REPO）
- [ ] GH_TOKEN 只授权了 `weight-tracker-data` 仓库、Contents 权限为 Read and write
- [ ] 已把 Worker 域名告知我，等待前端重新部署