# dsh-search-router

[English](README.md) · **中文**

基于 [XGrin/dsh-search-router](https://github.com/XGrin/dsh-search-router) 的 `d500bd7` 修复，当前适配 **DSH 0.2.0-rc.2**，此前已验证 **0.1.7-rc.2**；不支持更早的旧接口。插件向现有 `web_search` 注册一个搜索路由，可指定单个后端或顺序 fallback，不增加模型工具。

## 兼容范围

DSH web 的 peer 范围为 `^0.1.7-rc.2 || ^0.2.0-rc.1`。DSH 的兼容检查将预发布版纳入判断：允许 0.1.7-rc.2 ，以及从 0.2.0-rc.1 起的 0.2.x，包括后续补丁版本的 alpha、beta 和 RC。

只要插件依赖的接口保持兼容，就不需要仅因 DSH 发布范围内的新版本而更新插件。搜索、volatile Config、配置表单、凭据或插件插槽若发生破坏性变化，仍可能需要适配。

## 搜索后端

| 后端 | 默认凭据引用 | 默认端点 |
| --- | --- | --- |
| Exa | EXA_API_KEY | https://api.exa.ai |
| Tavily | TAVILY_API_KEY | https://api.tavily.com |
| Brave | BRAVE_SEARCH_API_KEY | https://api.search.brave.com |
| Perplexity | PPLX_API_KEY | https://api.perplexity.ai |
| DeepSeek | DEEPSEEK_API_KEY | https://api.deepseek.com/anthropic/v1 |
| SearXNG | 无；从 SEARXNG_BASE_URL 读取端点 | 自托管，需开启 JSON 格式 |
| DuckDuckGo | 无 | 公开 HTML 搜索 |

DeepSeek 后端自行调用 Messages API，默认模型 `deepseek-v4-flash`，每次请求最多允许 5 次服务端搜索；它不调用 DSH 的 `deepseek-official` 提供方。商业 API 可能计费。Perplexity 默认模型为 `sonar`。

## 本地安装

使用修复后的本地目录，不要直接安装尚未修复的上游版本：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-search-router
```

该命令会安装依赖、修改 profile，应先审查磁盘影响。本次 Windows 部署复用 E 盘既有 DSH 依赖并手动建立联接，具体路径见本地交付记录；无需为了刷新联接而在日常 profile 中运行依赖安装器。

插件 bundle 会选择 `web.searchProvider: search-router`、停用 `web-search-deepseek`，并开启 `tool-web`（fetch 关闭）。profile 自身补丁最后生效。添加覆盖时保留现有 web/tool-web 字段。**首次使用前明确选择后端**，避免自动探测选中付费服务：

```yaml
- id: search-router
  config:
    provider: deepseek
    timeoutMs: 10000
- id: web
  config:
    searchProvider: search-router
    fetchProvider: http
- id: tool-web
  disabled: false
  config:
    fetch: false
    searchTimeoutMs: 60000
```

## GUI 与 YAML 使用同一配置

进入 **插件 → dsh-search-router → 搜索路由**。支持增删后端、拖动排序（也可在拖动柄上使用方向键）、编辑密钥和端点、调整超时及空结果策略。一行表示单后端，多行表示按顺序 fallback。Exa 可留作手动选择项。

后端导出 volatile `Config`，下一次搜索读取最新配置，无需重启插件。前端使用 `configForms.get('search-router')`、共享配置镜像、`remote.credentials` 和第三方 `plugins.bundle.config` 插槽，已移除旧 `settings.register`、`settingsScope.bind`、`connection.api`。

GUI 以带版本检查的路径操作写入当前 profile 的 `cordis.patch.yml`；手动 YAML 编辑也是同一层。保存被拒绝、冲突或连接失败会显示失败；不会把未保存内容当成成功。断线及只读状态禁止写入，重连后同步共享状态；卸载会释放订阅并忽略迟到响应。

`provider` 与 `order` 互斥。GUI 在一次原子修改中更新两者，使用 `null` 清除继承的选择。下面两行是互为替代的示例，只使用其中一个：

```yaml
# 单后端
- id: search-router
  config:
    provider: deepseek
    order: null

# 或者：明确的 fallback
- id: search-router
  config:
    provider: null
    order: [deepseek, exa]
    timeoutMs: 15000
    emptyResultsFallback: true
    providers:
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        model: deepseek-v4-flash
      exa:
        apiKeyEnv: EXA_API_KEY
      searxng:
        baseURL: https://search.example.com
```

两者均未设置（包括均为 null）进入自动模式，按 Exa、Tavily、Brave、Perplexity、DeepSeek、SearXNG、DuckDuckGo 的顺序选择可用后端。GUI 的自动选择操作进入这个模式，不代表恢复为 DeepSeek。

各后端配置接受 `apiKey`、`apiKeyEnv`、`baseURL`（别名 `baseUrl`）、`baseUrlEnv`；仅 DeepSeek/Perplexity 支持 `model`。端点环境引用用于无密钥后端，有密钥后端使用显式或默认端点。`timeoutMs` 必须为 >=100 的整数，默认 10000。未知字段或冲突的路由配置会被拒绝。

## 凭据和重置

已有密钥通过 DSH 凭据服务读取，不迁移、不改写原凭据文件。优先使用凭据引用。

在卡片输入的密钥是 **profile 配置中的明文覆盖值**，界面和配置传输会隐藏密钥；隐藏不等于加密。它优先于凭据引用。普通字段修改只提交对应路径，不回写脱敏后的整个对象，因此不会覆盖隐藏密钥。重置删除 profile 覆盖并继承 bundle 配置；没有继承密钥时再读取凭据引用。请勿提交含密钥的 profile 文件。

旧独立 settings 文档不会自动迁移。如需保留旧设置，审查后手动转换到当前嵌套 YAML 格式。

## fallback 和取消

网络错误、非 2xx 状态、无效 JSON 和超时会继续下一个后端。超时覆盖响应头及完整响应体；调用者取消立即停止整条链。默认空结果也触发 fallback；如果所有成功响应均为空，返回空列表。`emptyResultsFallback: false` 时接受第一个成功的空结果。

## 开发验证

测试使用本地模拟端点并禁止外部请求。integration 使用真实 DSH WebRuntime、Settings 和 ConfigEditor，创建的文件保留在 `.local/test-runs`，清理单独进行。

已安装匹配的 DSH 包时：

```sh
node test/compatibility.mjs
node test/integration.mjs
node test/client-smoke.mjs
```

复用 Windows 上既有 DSH 源码时，设置 `DSH_ROOT` 为安装绝对路径、`TSX_TSCONFIG_PATH` 为其 tsconfig.json，使用 `node --import file:///E:/path/to/dsh/node_modules/tsx/dist/esm/index.mjs test/integration.mjs`。将命令中的 `test/integration.mjs` 换成 `test/compatibility.mjs` 可仅运行只读的版本检查测试。将 `DSH_HOME`、`TEMP`、`TMP` 指向本项目 `.local`，设置 `TSX_DISABLE_CACHE=1`、`NODE_DISABLE_COMPILE_CACHE=1` 禁用编译缓存。

旧 lockfile 及含个人机器路径的实时 probe 已删除，避免装回旧 DSH 包或误触发配置修改/付费搜索。自动测试不会调用真实 API；单独授权的真实宿主、GUI 和 API 验证见本地交付记录。GUI 隔离还必须显式配置默认工作区路径，仅设置 DSH_HOME 或进程工作目录不够。

删除 bundle 不会自动清除 profile 覆盖。回滚应恢复 profile 备份（含依赖清单和 lockfile），或明确选择 `deepseek-official`、启用 `web-search-deepseek` 并清理 router 覆盖；联接删除另行审查。

MIT。
