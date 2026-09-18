# ChatGPT Session 工具

本地零依赖小工具：粘贴一次 ChatGPT 的 Session JSON，即可：

1. **转登录态 Cookie** —— 把 `sessionToken` 转成 `__Secure-next-auth.session-token`（Cookie-Editor 格式），在浏览器里 Import 即可恢复登录态。纯前端完成，凭证不出本机。
2. **查询订阅** —— 套餐 / 到期日 / 自动续费状态 / 来源平台（官网、iOS、安卓内购）。
3. **取消自动续费** —— 一键打开官方订阅管理页（Stripe），关闭续费后权益保留到到期日，到期后不再扣款。

## 快速开始

需要 **Node 18+**（使用内置 `fetch`）。零依赖，无需 `npm install`：

```bash
node server.js          # 或 npm start
```

打开 http://127.0.0.1:8787 即可使用。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。默认只绑本机；如需局域网访问改成 `0.0.0.0`（不推荐，见安全说明） |

## 运行测试

```bash
npm test
```

## 获取 Session

登录 chatgpt.com 后，在浏览器地址栏打开：

```
https://chatgpt.com/api/auth/session
```

把整段返回的 JSON 复制粘贴进页面顶部输入框即可。

## 工作原理

```
浏览器 (index.html)  ──► 本地代理 (server.js, 127.0.0.1)  ──► chatgpt.com/backend-api
      ▲                                                        │
      └────────── 响应只回本页，不出网络 ◄───────────────────────┘
```

- **Cookie 转换**：纯前端，把 `sessionToken` 包装成 Cookie-Editor 的导入格式，不经过代理，也不出本机。
- **查询订阅**：代理调用 `accounts/check/v4-2023-04-27` 拿账号列表，再对每个账号调 `/subscriptions` 取最准的到期日与 `will_renew` 状态。
- **取消续费**：代理调用官方 `payments/customer_portal` 拿管理链接，最后一步在官方页面确认——只做官方接口，不做逆向猜测。

## 安全说明

- 服务**默认只绑定 127.0.0.1**，accessToken 只在你自己的机器上流转。
- 页面带严格 CSP（`script-src 'self'` 等）与 `X-Frame-Options` / `nosniff` 等安全头。
- 上游响应、错误信息等动态内容全部经 HTML 转义后渲染，防注入。
- 对你的凭证负责：Session 等同临时登录钥匙，用完可在 ChatGPT「退出所有设备」收回；异地/自动化操作账号有触发风控的风险。

## 已知边界

- 查询/取消走本机代理请求 `chatgpt.com`。本地跑=住宅 IP，最不容易被 Cloudflare 拦；若返回 403，换干净网络重试。
- **手机内购订阅**（App Store / Google Play）必须在对应商店里取消，官方管理页管不了，页面会提示。
- 免费账号调 `/subscriptions` 常返回 404，属正常现象。
- 上游字段可能漂移，代码全部做了可选读取 + 保底值，随官方 API 变化可能需小幅适配。

## License

[MIT](LICENSE)