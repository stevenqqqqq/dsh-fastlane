# dsh-fastlane

[![DeepSeek Harness](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.5-blue)](#兼容性) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A speedup layer for **DeepSeek Harness (DSH)**: zero-call turn classification (L0) + tail-injected plan directives with a parallel hint (L1/L2) + deterministic context pruning (L3) + opt-in pattern reuse (L4). Every layer is independently switchable; `mode: shadow` keeps classification and metrics while disabling every mutation.

DSH 运行加速的**分层实现**：回合分类（L0）+ 计划与并行指令（L1/L2）+ 确定性剪枝（L3）+ 模式复用（L4）。默认 `mode: active`（L4 关闭），每一层可单独关闭，`mode: shadow` 退回纯观察。

## 安装

```yaml
# profile 的 cordis.patch.yml（与本包 cordis.patch.yml 同构）
- insert:
    - id: dsh-fastlane
      name: dsh-fastlane
      config: { enabled: true, mode: active }
```

或用 DSH 的 `plugin_manager`：`install_bundle` 指向本仓库目录/打包产物，装完 `set_plugin` 对 entry `include:dsh-fastlane` 先 false 再 true 重载。

**注意**：本插件不导出 `Config` schema，也不依赖 `@deepseek-ai/schemastery`。`link:` 方式安装按真实路径解析，插件目录下没有 `node_modules` 时，导入 schemastery 会让整个 bundle 静默不加载；Cordis 只在插件声明 `Config` 时才校验（`cordis/lib/index.js:245`），省略 schema 既免依赖，配置键照样透传给 `apply`。

## 为什么是这一层

调研结论（`docs/RESEARCH.md`）：没有任何现成插件同时满足三条需求。需求③已由 `billion-context` 覆盖；①② 缺的是"进入回合先分类 / 复杂任务先出计划"这一层，而现有候选各有硬伤——`planning-with-files` 每轮注入计划伤前缀缓存，`dsh-routing-suite` 只换系统提示风格、不分类也不并行，`dsh-fast` 只做只读诊断。唯一验证过"跳过整次模型回调"的样板是 `dsh-harnessmm`，但它面向工具动作复用，不含任务分类。

于是自建 `dsh-fastlane`，四层分期：

| 层 | 挂点 | 行为 | 状态 |
|---|---|---|---|
| L0 分类 | `llm/stream`（只读包裹） | 按请求内容判定 `reuse` / `direct` / `plan` / `normal`，记录证据 | 已交付 |
| L1 计划 | `agent/pre-step` | 复杂回合在尾部追加计划消息（`source.kind='plan-mode'`，hash 去重） | 已交付 |
| L2 并行 | 计划指令 | 点名互不依赖单元，要求同一条 assistant 消息并行发出 | 已交付（指标化） |
| L3 剪枝 | `tools/result` → `compaction/prune` | 确定性折叠重复/机器输出，错误与栈帧逐字保留 | 已交付 |
| L4 复用 | `llm/stream` 替换 | 命中 pattern 直接合成流，不调模型；默认关闭 | 已交付（opt-in） |

## 为什么分类放在 `llm/stream` 而不是 `agent/pre-step`

`agent/pre-step` 的 payload 是 `{messages, turn, step, signal, modelSelection}`，**没有 session / agent 身份**，写下的记录无法归因到会话与用量；`llm/stream` 的请求对象带 `sessionId`，其 chunk 里带 `usage`（`inputTokens / cacheReadTokens / cacheWriteTokens / uncachedInputTokens`），缓存证据只在这里拿得到。L1 的计划注入会另挂 `agent/pre-step`——那里只需要往 `messages` 追加一条，turn/step 已足够。

## 缓存安全

- L0：不改 `options.messages`、不改请求头（provider/model/effort/sampling）、不提前 `next()`、不发起额外模型调用；包裹只为读出 `usage` 与 `tool call`，chunk 原样透传。
- L1：计划只追加在 `messages` **尾部**，且同一 `plan_id` 只注入一次；前缀（系统提示 + 历史）逐字节不变。
- L3：只改写"足够旧"的工具结果（`minTurnsBeforeFold`），且先写 `compaction/prune` 再 replace，billion-context 的折叠账本仍可归因。
- L4：命中即完全跳过模型回调（`finish` 由合成流给出、不发 `usage`），因此默认关闭，只在人工审阅过的 pattern 上开启。
- `/acp-cache` 的归因可以直接对比开关前后。

## 分类规则（`lib/classify.mjs`，纯函数）

特征：字符数、行数、路径/文件数、代码块、枚举项、序列词（然后/接着/分别…）、意图动词（中英）、报错标记、URL、slash 命令、问题句式、工具面数量。
打分后：`score >= 3` → `plan`，`score <= -2` → `direct`，同载荷命中次数达阈值 → `reuse`，其余 `normal`。每条记录都带 `reasons`，误判可归因到具体项。

关键边界：运行时上下文（`<system-reminder>` / `source.kind === 'runtime-context'`）每步都追加为最后一条 user 消息，所以"最后一条是 user 就当作新回合"会误把所有工具续步算成新回合；`turnEntry()` 显式跳过它，只有"user 之后只剩运行时上下文"才算回合入口。

## 日志记录类型

`~/.dsh/fastlane/shadow.jsonl`，一行一条，8 MB 轮转为 `.1`，文件权限 0600：

| `kind` | 何时写 | 用途 |
|---|---|---|
| `mount` | 插件挂载 | 证明 bundle 已加载、记录本次日志路径 |
| `enter` | 每次 `llm/stream`（`debug: true`） | 请求形状 + 分类决定（`decision/route/score/reasons`） |
| `skip` | 续步被跳过（`debug: true`） | 续步占比，避免把工具循环误当回合 |
| `turn` | 回合流结束（含 `finally` 提前退出） | 路由、特征、重复命中、chunk/文本/工具调用、首 chunk 与总耗时、`usage` |
| `error` | 分类器抛异常（理论不发生） | 兜底：记一条后照常放行，绝不影响模型调用 |

## 配置

```yaml
- id: dsh-fastlane
  name: dsh-fastlane
  config:
    enabled: true
    mode: active          # active 生效；shadow 只观察；off 关闭
    logFile: ''           # 空 = ~/.dsh/fastlane/shadow.jsonl
    reuseMinHits: 2
    stepRecords: false    # true 时工具续步也整条落盘（体积大）
    maxLoggedTextChars: 4000
    debug: true           # 额外落 enter（每次请求）与 skip（续步）记录
    plan:                 # L1/L2
      enabled: true
      maxSteps: 6
      maxStepChars: 64
    prune:                # L3
      enabled: true
      thresholdChars: 8192
      headChars: 4096
      tailChars: 1024
      minTurnsBeforeFold: 3
      minDuplicateChars: 1200
      maxPerPass: 4
      everyEvents: 6
      diagnostics: false  # true 时每个被扫描的工具结果写一条 pscan（调检测器用）
    reuse:                # L4，默认关闭
      enabled: false
      requireThinking: true
      patternsFile: C:/Users/steven/.dsh/fastlane/patterns.json
```

本插件**不导出 `Config` schema**，也不依赖 `@deepseek-ai/schemastery`：`link:` 安装按真实路径解析，插件目录下没有 `node_modules`，导入 schemastery 会 `ERR_MODULE_NOT_FOUND` 让整个 bundle 静默不加载。Cordis 只在插件声明 `Config` 时才校验（`cordis/lib/index.js:245`），所以省略 schema 既免依赖，配置键也照样透传给 `apply`。

改动生效需要重载入口，**保存文件不会热加载**：

```powershell
# plugin_manager 工具（entryId = include:dsh-fastlane）先 false 再 true
```

## 验证

```powershell
$node = "C:\Users\steven\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$env:ELECTRON_RUN_AS_NODE = 1
& $node --test "plugins\dsh-fastlane\test\classify.test.mjs"
& $node "plugins\dsh-fastlane\scripts\aggregate.mjs"
```

`aggregate.mjs` 输出：每条路由的回合数/占比、平均分与置信度、**零工具调用占比**（"直接回答是否够用"的代理指标）、`cache-hit`（`cacheReadTokens / (inputTokens + cacheRead + cacheWrite)`；DSH 的 `inputTokens` 是**未命中**输入，详见 `dsh-token-meter/lib/index.js:328-332`）、首 chunk 延迟中位数、重复载荷直方图、abandoned 流计数。`purpose` 非空的辅助调用（auto-review、标题生成等）不计入回合统计。

## P0 实测（2026-11-27，profile=desktop）

| 观测 | 结果 |
|---|---|
| 挂载 | `mount` 记录写入 `~/.dsh/fastlane/shadow.jsonl`，entry `include:dsh-fastlane` phase=active |
| 可见范围 | 主会话与 **子代理都在监听范围内**（子代理用自己的 `sessionId` 独立成条，例如 7 条消息的 spawn 子代理记为 `decision=turn`） |
| 流结束 | 调用方常在 `finish` 处提前退出，生成器走 `return()`；记录改在 `finally` 写，`abandoned=true` 属正常 |
| 缓存 | 实测 `cache-hit` 95.8%–99.3%，与 billion-context 声称的 96–99% 前缀命中一致 |
| 分类 | `plan` 出现在带文件枚举/多步指令的请求上（score 4.5），普通提问落 `normal`（score 0–1） |
| 行为 | 纯透传，零额外模型调用；`usage` 字段与 `/acp-cache` 归因一致 |

误判率需要真实用户回合样本累积后再判：P0 的产出是**分布+可归因证据**，不是"已经提速"。


## P1–P4 实测（2026-11-27，profile=desktop，`mode: active`）

首轮 `mode: active` 全量的 `aggregate.mjs`：`records 19293 / turns 72 / steps 276 / auxiliary 327`。

| 层 | 落地方式 | 观测 |
|---|---|---|
| L1 计划 | `agent/pre-step`（只认 `messages.length > 0` 的首步）→ 尾部追加 `source.kind='plan-mode'` 计划消息，`plan_id` 去重 | `plan` 路由 5 回合（6.9%，平均 score 6.00、置信 0.94），实际注入 2 次、去重后 2 份计划；指令含 steps/parallel/verify/rules |
| L2 并行 | 计划指令写明"互不依赖单元 → 必须在同一条 assistant 消息里并行发出" | 全量并行比 2/51 = 3.9%（低：无并行价值的回合占多数，此指标只作基线） |
| L3 剪枝 | `tools/result` 节流扫描 → `compaction/prune` + surface `replace` | 首轮 landed 1 次、裁掉 9134 字符；子代理侧实测 `…[fastlane pruned 9166 chars]…` 生效 |
| L4 复用 | `llm/stream` 命中 pattern 直接合成流，不调模型 | 3 次同题第 3 次命中：子代理原样收到模板文本 + `fastlane reuse: pattern zebra-smoke v1` 尾注，`reuse` 路由 4 回合、命中 5 次（含辅助调用，见下） |

三条实现中踩到的坑（都已在代码里修掉，留档避免复发）：

1. **`agent/pre-step` 的 `step` 是会话生命周期步号**，不是回合内步号；`payload.messages` 只是本次 claimed 的新消息。判断"回合开头"只能用 `messages.length > 0`。
2. claimed 消息可能是**系统通知**（子代理完成 `subagent-settled`、子代理投递 `agent-message`、`plan-mode`、`runtime-context`），必须按 `source.kind` 过滤，否则通知会被当成新任务注入一份计划。
3. **辅助调用也会走 `llm/stream`**（auto-review、标题等，带 `purpose`）。L4 必须跳过它们：否则 reviewer 收到模板文本而不是 JSON 结论，会直接报 `Unexpected token ... is not valid JSON`。
4. 重复计数改为 **`sessionId + repeatKey` 复合键**，并且辅助调用不计数：否则主会话的 auto-review 与子代理回合会互相污染计数。
5. L3 的 `age` 门（`minTurnsBeforeFold`）意味着**新会话前几个回合基本不折叠**，这是刻意的：只改写足够旧的工具结果，被作废的缓存前缀才短。

## 判定 P0 通过的标准（历史，已满足）

- 分类分布不是退化的（`normal` 不应吃掉 >70%）。
- `direct` 路由中零工具调用占比 ≥90% → 说明"直接答"判断成立。
- 重复载荷 ≥10%，且重复载荷的缓存命中率显著高于一次性载荷 → L3 复用有据。
- 误判样本可从 `reasons` 逐条修正规则，不需要引入分类模型。

## 已知限制

- 记录以 `sessionId` 归属；子代理另有 session，会在日志里独立成条（`purpose` 非空的辅助调用已在聚合里剔除）。
- `debug: true` 会给每个工具续步写一条 `skip`；`prune.diagnostics: true` 每个被扫描结果写一条 `pscan`（实测一轮上百条），只在调检测器时开。
- 计数器是进程内 LRU（512 条），重启/重载清零；因此"第 3 次同题才复用"在重载后从头数。
- L4 默认关闭：pattern 命中会跳过模型回调，答案质量完全取决于模板与 provenance，开启前先用 `scripts/mine.mjs` 看候选、人工审阅后写 `patterns.json`。
- L4 只对同一 `sessionId` 内、标准化后完全相同的载荷生效；辅助调用（带 `purpose`）永不参与。
- L3 只折叠"足够旧"（`minTurnsBeforeFold`）的重复/机器输出，且每轮最多 `maxPerPass` 条；短会话几乎不触发属预期。
- 分类只看请求内容，看不到"上次同一任务是怎么做完的"；跨会话模式复用不在当前范围。
- `mine.mjs` 只给候选（hits/无工具调用占比/建议匹配），不会自动写 patterns。
