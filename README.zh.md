# dsh-search-router

[English](README.md) · **中文**

一个轻量的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
插件：向 `ctx.web` 注册一个原生 `WebSearchProvider`，把每次 `web_search`
调用转发到你选择的搜索后端——失败时按顺序自动切换。模型看到的仍是同一个
`web_search` 工具；没有新工具、没有 MCP、没有重排序、没有缓存。

```
DSH Agent → web_search → ctx.web → dsh-search-router → Exa / Tavily / Brave / SearXNG
```

## 支持的提供方

| 提供方 | 凭据 | 端点 |
| --- | --- | --- |
| **Exa** | `EXA_API_KEY` | `https://api.exa.ai` |
| **Tavily** | `TAVILY_API_KEY` | `https://api.tavily.com` |
| **Brave** | `BRAVE_SEARCH_API_KEY` | `https://api.search.brave.com` |
| **SearXNG** | 无（自托管） | `SEARXNG_BASE_URL` |

SearXNG 让本路由器可以完全自托管——不依赖任何商业 API。实例需开启
`json` 输出格式（其 `settings.yml` 中的 `search.formats`）。三个商业提供方的
端点均可按提供方覆盖（见下方完整 schema）。

## 安装

```bash
dsh plugin --profile web add link:/path/to/dsh-search-router   # 本地目录
dsh plugin --profile web add dsh-search-router                 # 或发布后
dsh web
```

组合补丁会把 web seam 指向本路由器、停用内置的 DeepSeek 搜索，并在 web
profile 中重新启用 `web_search` 工具。卸载（`dsh plugin --profile web remove
dsh-search-router`）即恢复原始组合。

## 配置

两种方式，控制同一组开关——GUI 逐字段优先，GUI 里重置则回落到组合层的值。
零配置时，路由器自动探测所有能拿到密钥或端点的提供方，按固定顺序尝试：
exa → tavily → brave → searxng。

### 在应用里

**设置 → 插件 → 插件配置** 中的“搜索路由”卡片：每个生效提供方一行，按
故障切换优先级编号，**可拖拽排序**（也支持键盘排序）；每行有内联编辑器，
另有添加提供方入口和高级折叠区（超时、空结果策略）。所有改动即时生效，
无需重启。

在此输入的 API Key 以密文持久保存在设置文档中，并**覆盖**环境变量；清除
已存密钥即回落到 `EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY`。

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
      exa:    { apiKey: …, apiKeyEnv: EXA_API_KEY, baseURL: … }
      tavily: { apiKey: …, apiKeyEnv: TAVILY_API_KEY, baseURL: … }
      brave:  { apiKey: …, apiKeyEnv: BRAVE_SEARCH_API_KEY, baseURL: … }
      searxng: { baseUrl: …, baseUrlEnv: SEARXNG_BASE_URL }
```

会提交的文件里请优先用 `apiKeyEnv`，而非明文 `apiKey`。

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
