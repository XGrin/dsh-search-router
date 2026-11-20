# dsh-search-router

[English](README.md) · **中文**

一个轻量的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
插件：向 `ctx.web` 注册一个原生 `WebSearchProvider`，把每次 `web_search`
调用转发到你选择的搜索后端——失败时按顺序自动切换。模型看到的仍是同一个
`web_search` 工具；没有新工具、没有 MCP、没有重排序、没有缓存。

```
DSH Agent → web_search → ctx.web → dsh-search-router → Exa / Tavily / Brave / SearXNG
```

## 环境要求

**DSH 0.2.2 或更高版本。** 插件基于 0.2.2 的插件机制构建：配置是行的 `Config`
schema、字段标记为 `.volatile()`，图形界面表单通过 `plugins.row.config` 客户端槽位
提供。0.1.x 上不可用（那时这两者都还不存在）。

## 支持的提供方

| 提供方 | 凭据 | 端点 |
| --- | --- | --- |
| **Exa** | `EXA_API_KEY` | `https://api.exa.ai` |
| **Tavily** | `TAVILY_API_KEY` | `https://api.tavily.com` |
| **Brave** | `BRAVE_SEARCH_API_KEY` | `https://api.search.brave.com` |
| **Perplexity** | `PPLX_API_KEY` | `https://api.perplexity.ai` |
| **DeepSeek** | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/anthropic/v1` |
| **SearXNG** | 无（自托管） | `SEARXNG_BASE_URL` |
| **DuckDuckGo** | 无 | — |

SearXNG 让本路由器可以完全自托管——不依赖任何商业 API。实例需开启
`json` 输出格式（其 `settings.yml` 中的 `search.formats`）。DuckDuckGo 无需
密钥，因此零配置的部署也能直接提供网页搜索。各提供方端点（及
Perplexity/DeepSeek 的模型）均可按提供方覆盖（见下方完整 schema）。

## 安装

```bash
dsh plugin --profile web add github:XGrin/dsh-search-router
dsh web
```

或克隆到本地后以链接方式安装（开发时）：

```bash
git clone https://github.com/XGrin/dsh-search-router.git
dsh plugin --profile web add link:/path/to/dsh-search-router
```

组合补丁会把 web seam 指向本路由器、停用内置的 DeepSeek 搜索，并在 web
profile 中重新启用 `web_search` 工具。卸载（`dsh plugin --profile web remove
dsh-search-router`）即恢复原始组合。

## 配置

控制同一组开关。零配置时，路由器自动探测所有能拿到密钥或端点的提供方，
按固定顺序尝试：exa → tavily → brave → perplexity → deepseek → searxng → duckduckgo。

### 在应用里

插件自带浏览器端，注册了 `plugins.row.config` 条目，因此在**插件**面板
（侧边栏面板，不是"设置 → 内置插件"）中，它的行会带有**配置**入口：
打开该 bundle，展开"包含的组件"，选中 `search-router` 那一行。改动实时生效，无需重启。

每个提供方行都可以直接**填入 API Key**。该字段声明为 `role('secret')`：DSH 会把值
存进 profile 的密钥库，从所有设置响应中剥离（浏览器只知道"是否已设置"），也不会写进
组合配置文件。留空则回落到启动环境变量或 `providers.<id>.apiKeyEnv`。

### 在组合层

profile 自己的补丁层——`$DSH_HOME/profiles/web/cordis.patch.yml`（不存在则
创建）。补丁会整体替换该行的 `config`，需写完整块。两个示例：

```yaml
# Tavily，失败时切换到自托管 SearXNG
- id: search-router
  config:
    order: [tavily, searxng]
    providers:
      tavily: { apiKeyEnv: TAVILY_API_KEY }
      searxng: { baseUrl: https://search.example.com }

# 仅 SearXNG——完全不使用商业密钥
- id: search-router
  config:
    provider: searxng
    providers:
      searxng: { baseUrl: http://127.0.0.1:8888 }
```

完整 schema：

```yaml
- id: search-router
  config:
    provider: exa                  # 单提供方模式（与 order 互斥）
    order: [exa, tavily, searxng]  # 故障切换链模式
    timeoutMs: 10000               # 单提供方超时（默认 10000）
    emptyResultsFallback: true     # 零结果视为失败（默认 true）
    providers:
      exa:        { apiKey: …, apiKeyEnv: EXA_API_KEY, baseURL: … }
      tavily:     { apiKey: …, apiKeyEnv: TAVILY_API_KEY, baseURL: … }
      brave:      { apiKey: …, apiKeyEnv: BRAVE_SEARCH_API_KEY, baseURL: … }
      perplexity: { apiKey: …, apiKeyEnv: PPLX_API_KEY, baseURL: …, model: sonar }
      deepseek:   { apiKey: …, apiKeyEnv: DEEPSEEK_API_KEY, baseURL: …, model: deepseek-v4-flash }
      searxng:    { baseUrl: …, baseUrlEnv: SEARXNG_BASE_URL }
      duckduckgo: { baseURL: … }
```

在 GUI 表单里填写的 `apiKey` 会由 DSH 作为密文保管（`role('secret')`）：该值不会
出现在任何设置响应里，也不会以明文写进本文件——回写时是 `{{SECRET_…}}` 占位符，
由 Host 在读取时解析。若 key 已存在于启动环境中，优先用 `apiKeyEnv` 引用。

## 故障切换

网络错误、超时、任何非 2xx 状态码、无法解析的响应都算失败，默认情况下零
结果也算（可设 `emptyResultsFallback: false` 关闭）。路由器按顺序尝试整条
链，返回首个成功结果；模型不会看到之前提供方的失败。只有全部失败时
`web_search` 才抛出一个汇总的、不含密钥的错误：

```
search-router: all configured search providers failed:
- exa: HTTP 429
- tavily: timeout after 10000ms
- searxng: HTTP 503
```

## 开发

```bash
node test/integration.mjs /path/to/a/dsh/installation/node_modules   # 路由器对真实 seam，模拟提供方
node test/client-smoke.mjs                                          # 浏览器 bundle，按 shell 的方式加载
```

MIT。
