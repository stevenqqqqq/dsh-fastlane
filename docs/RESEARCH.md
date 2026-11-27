# DSH 运行提速：插件调研结论与定制方案

调研对象：本机 DSH 0.2.2-rc.5，profile `desktop`，工作目录 `C:\Users\steven\WorkBuddy\deepseek harness`。
依据：内核源码（app.asar 内 `@deepseek-ai/*`）、npm registry 实测清单、本机已装插件源码。
结论先行：**没有任何单个插件同时满足三条需求**。上下文压缩（需求③）有成熟件且已装；分类/答案复用（需求①）与计划+并行（需求②）只有半个答案，且现有实现方式恰好损伤前缀缓存。建议自建 `dsh-fastlane`（三档路由 + 尾部注入 + 确定性剪枝），复用 billion-context 与 HarnessMM 的既有机制，不替换它们。

---

## 1. 先钉死机制事实（决定方案可行性，均来自 0.2.2-rc.5 内核）

| 扩展点 | 形态 | 能做什么 | 硬约束 |
|---|---|---|---|
| `agent/pre-step` | waterfall，入参 `{messages, position, signal, modelSelection}` | 返回 `{kind:'enter', messages}` 可**改写本轮送给模型的全部消息**；返回 `{kind:'reject'}` 可中止 | 在 `systemPrompt.assemble()` 之后调用；step 0 返回空 messages 会直接结束该 turn 且不调模型（`dsh-agent-loop/lib/index.js:764-768`） |
| `agent/request` | waterfall，返回调用配置 | 可改 sampling/controls | **改 provider/model/reasoningEffort 直接抛错**：`"use agent.model.select() before step preparation"`（`dsh-agent-loop/lib/index.js:1013-1014`） |
| `system-prompt/assemble` | waterfall，入参 `{sections, contexts, variables}` | 增删改系统提示段 | 段在 prompt **最前部**；每轮文本变化=整段前缀缓存失效 |
| `llm/stream` | waterfall | 可**伪造模型流**（HarnessMM 就此跳过整次模型回调） | 请求对象 frozen，无 agent 引用，只有 `sessionId` 可作身份 |
| `tools/pre-execute` / `tools/execute` / `tools/result` | waterfall / 观察 | 校验入参、改写结果、拿真实 receipt | 无 message history |
| `compaction/prune` | 会话 surface 事件（shadow 定价） | 重写工具结果节点，可回放、可逆 | 需自建 `Service`（参照 `dsh-compaction-tool-result-pruner`） |
| `token-meter` | 服务 | 提供 `uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens` | 已按 step 记账，可直接算命中率 |

两条被源码写死的缓存事实：
- `dsh-llm/lib/types/call-config.js:399-403`：provider/model/effort/sampling 属 request-header 状态，"can affect cache reuse"，waterfall 替换后 loop 只记录变更快照 —— 即：**换模型=前缀缓存作废**。
- 运行时上下文由 `runtimeContext.project(sections)` 生成并**追加为本轮最后一条消息**（`dsh-agent-loop/lib/index.js:704-708`）。这是 DSH 唯一的缓存友好注入位；把每轮变化的东西塞进 system prompt 是反模式。

---

## 2. 候选清单与匹配度

匹配度口径：● 直接满足 / ◐ 部分满足需改造 / ○ 不满足。评分为该需求下的可用度（0–5）。

| 候选（版本/状态） | 机制（挂点） | ①分类+复用+缓存 | ②计划+并行 | ③压缩剔冗余 | 局限 | 可借鉴点 |
|---|---|---|---|---|---|---|
| **billion-context 0.1.216**（已装、在用） | 代理层改写流 + 4 工具 `compress/decompress/search_context/acp_status`；`tools/change`、`llm/stream`；patch 里 `compaction-basic auto:false` + `bili-compaction-gate` | ○ 2 | ○ 0 | ● 5 | 压缩由**模型自己决定**（nudge 每 ~50K token 增长，`compress.nudgeGrowthTokens`），插件无法按任务类型联动；无分类、无计划、无并行；接管了宿主 compaction 后端 | 唯一提供**缓存归因**（`/acp-cache`：new content / compression re-pay / upstream-ttl / client-rewrite）与 fold 经济学；自称健康会话 96–99% 前缀命中、压缩开销 ≤2%；分块小范围摘要 + 可逆 | 
| **@aiwayds/dsh-dcp 0.14.2** | 确定性压缩后端；patch 直接 `compaction-basic disabled:true` + 插入自己（`thresholdRatio 0.7`） | ○ 0 | ○ 0 | ◐ 4 | **与 billion-context 抢同一后端**，两者不可并存；纯规则剪枝，质量看规则；注册表上 `dsh-dcp@0.0.1` 只是占位包（1.4KB，"name reserved"），真包是 `@aiwayds/dsh-dcp` | 零 LLM 摘要、逐字保留路径/命令/报错/未完成 todo —— 这是"剔除无关内容"最省时的形态 |
| **compaction-tool-result-pruner**（内核内置，本机 disabled） | `Service toolResultPruner`，对超阈值工具结果做 head/middle/tail 剪枝，写 `compaction/prune` shadow 事件 | ○ 0 | ○ 0 | ◐ 3 | 只按字符数剪，无内容判断；每 8KB 才触发（`thresholdChars 8192/head 4096/tail 1024`） | **最小可用剪枝骨架**：确定性、可回放、按 code point 切、rich block 顺序保留 —— 自研 pruner 直接照抄其形状 |
| **dsh-routing-suite 0.1.2** | 仅 `system-prompt/assemble`，且只在自带 preset 会话内生效 | ◐ 2 | ○ 0 | ○ 0 | 只按"第一条持久用户任务"选**工作风格**（auto/inspect-first/direct），不省任何一次模型请求、不改模型、不缓存答案；ambiguous 直接中立；要额外装 preset 目录 | 证明了"任务进来自动分类"在 DSH 里可行且**零额外模型调用**（纯启发式）；分类结果与策略分离的配置形态（`enabled/strategy`）值得照抄 |
| **dsh-planning-with-files 1.0.1** | 单行 bundle；per-turn plan 注入、写提醒、compaction 恢复、`agent/turn-stopping` 完成门、`pwf_*` 工具、`/pwf` | ○ 1 | ◐ 3 | ○ 1 | 计划靠**每轮注入**（文本变化即伤前缀缓存）；完成门会额外制造往返；面向"文件式计划持久化"，不解决并行调度 | per-turn plan 注入 + 完成门 = 需求②的骨架；其"compaction 后恢复计划"思路可直接搬到自研实现 |
| **AgentTeams 0.1.31**（已装） | captain 出 DAG → 成员并行执行、任务级 attempt、质量门 | ○ 0 | ◐ 3 | ○ 0 | 重装备：需批准、开新会话、成员各自上下文；一次简单三路检索不值得 | 真正的并行执行器；自研插件的"复杂任务"分支应**委托它**而不是自己造调度 |
| **HarnessMM**（已装、本机已打补丁） | `system-prompt` 注入 CHISEL_PLAN + `llm/stream` 边界替换 + `tools/execute` 逐字校验 + `tools/result` 证书；receipts 落 `~/.dsh/harnessmm/receipts.jsonl` | ◐ 2 | ◐ 1 | ○ 0 | 复用对象是**工具动作**，不是"答案/计划"；候选需在根调用旁一次性冻结；thinking 端点要求回填 thinking block，否则 400 | **唯一验证过"跳过整次模型回调"的机制样板**：waterfall 返回合成流、dispatch 侧逐字复核、每次替换发证书。需求①的 fast-path 必须复用它这套形状 |
| **dsh-fast 0.2.33** | 只读诊断：`/fast` + `fast_report`，记 session load、spill 命中、compaction 次数、上下文注入 token 占比、LLM 缓存命中率 | ○ 0 | ○ 0 | ○ 0 | 纯观测，不提速；能力声明 `sessions:read` | 现成的**度量底盘**：自研插件先接它或照它的指标定义打点，避免自造指标口径 |
| dsh-model-router 0.82.5 / task-board-plugin | 按依赖拆工作包、派给外部模型/CLI 或一次性子代理 | ◐ 1 | ◐ 2 | ○ 0 | 编排在 DSH 之外（CLI 侧），与本机 profile/缓存无关；引入外部进程延迟 | 仅取"按依赖切包 + 费用预览"的产品形态 |
| dsh-context 0.87.1（已装）/ dsh-context-doctor / dsh-cost-meter | 只读观测/审计 | ○ | ○ | ○ | 不提速 | 无 |

**不建议装**：`@aiwayds/dsh-dcp`（与已装 billion-context 争 compaction 后端，且 billion-context 的 gate 入口必须常开，混装会走"双压/pending"路径）；`dsh-routing-suite`（改变行为但不提速，且要覆盖你现有 preset 组合）。

---

## 3. 缺口诊断（为什么必须自建）

1. **需求① 无人实现**。routing-suite 只做"风格选择"，planning-with-files 只做"计划持久化"，HarnessMM 只复用"工具动作"。三者都没有：任务指纹 → 答案模板 → 直接返回。而 DSH 恰好留了口子：`agent/pre-step` 可改写消息、`llm/stream` 可伪造流、`token-meter` 可读缓存命中。
2. **需求② 的两半是分裂的**。计划注入在 planning-with-files，并行执行在 AgentTeams；中间没有"判定该不该并行、并把并行意图写进计划"的那一层。
3. **需求③ 已满足但不可编程**。billion-context 的压缩时机在模型手里，插件层拿不到"这轮该压到多少"的控制权；确定性剪枝件（dcp / pruner）又都盯着同一个后端，无法与它叠加。
4. **现有实现与缓存目标相冲**。凡把每轮变化的文本放进 system prompt（routing-suite、planning-with-files 的做法），都会让整段前缀失效 —— 与需求①"提升缓存命中"直接矛盾。这是本次调研最关键的反直觉结论：**提速不能靠"每轮改写系统提示"，只能靠"尾部追加 + 内容哈希去重 + 少发请求"**。

---

## 4. 定制方案：`dsh-fastlane`（可落地）

定位：**一个插件、四个挂点、三个档位**，不改内核、不与 billion-context 争后端。

```
plugins/dsh-fastlane/
  lib/index.js        # 插件入口：读 config，装配下面四层
  lib/router.js       # L0 分类器（纯启发式，可选迷你模型兜底）
  lib/fastlane.js     # L1 答案模板复用（llm/stream 合成流）
  lib/planner.js      # L2 计划尾部注入 + 并行意图
  lib/pruner.js       # L3 确定性剪枝（compaction/prune）
  lib/metrics.js      # 打点：命中率/分类分布/回收的回调数
  fastlane.patterns.json  # 模板银行（人可审、可版本化）
  cordis.patch.yml
```

### L0 分类器 —— `agent/pre-step`（需求①前半）

输入：本轮最后一条 user 消息、本 turn 已发生工具数、pattern 银行。
特征（全部本地计算，零模型调用）：消息码点数、是否含 `@file`/路径/命令片段、意图动词（查/读/改/跑/写/为什么）、与每个 pattern 的指纹相似度（SimHash-64 + 槽位差异数）、该 pattern 历史成功/被纠正次数。
输出 `route ∈ {trivial, cached, plan, normal}` + `confidence`：

- `trivial`：码点数 ≤ 240 且无工具意图且 pattern 银行无匹配 → 追加一行"直接回答，勿展开"尾注，仍走模型（省的是输出长度与工具往返，不是回调）。
- `cached`：pattern 匹配 相似度 ≥ 0.9、槽位可由正则抽取、历史成功 ≥ 3 次且未被纠正 → 交给 L1。
- `plan`：预估步骤 ≥ 3 或 tool 意图 ≥ 2 类 → 交给 L2。
- `normal`：confidence < 0.65 或任何异常 → **fail-open**，一行日志，绝不阻塞主流程。

可选 `selector`（默认关）：与 HarnessMM 同样的"1 字符选择"用法，仅在 heuristic 落在 0.5–0.65 灰区时发一次 32-token 分类请求；预算上限 `selector.maxPerTurn = 1`。

### L1 答案复用 —— `llm/stream`（需求①后半，真省回调）

命中 `cached` 时，在 `llm/stream` 处以 waterfall 直接返回合成流：模板正文 + 槽位填充 + 尾部"数据来源/时效"两行；写 receipt（pattern id、模板版本、槽位取值哈希、被绕过的回调数）。
必须守住的四条：
1. **只在 thinking 不可用的路由上启用**（thinking 端点要求回填 thinking block，否则 400）；配置 `requireThinking: false` 时才允许替换。
2. **必须带 provenance**：模板里每个事实槽位记录来源（文件/命令/上一次会话 seq）；无来源的槽位不许命中。
3. **必须可降级**：用户在同一会话内对结果提出纠正 → 该 pattern 立即 `demote`（成功计数清零 + 冷却 7 天）。
4. **必须可关**：`fastlane.enabled=false` 时行为与未装完全一致。

### L2 计划 + 并行意图 —— `system-prompt` 静态段 + `agent/pre-step` 尾部注入（需求②）

- 系统提示只放**一段稳定文本**（格式与规则，写入 `system-prompt/assemble`，全文不含任何每轮变量），保证前缀不变。
- 每轮计划以 **plan_id = sha256(任务指纹 + 步骤清单)** 生成；`plan_id` 未变则**不重复注入**（这是与 planning-with-files 的关键差异：它每轮注，我们只在计划变化或 missing 时注）。
- 注入位置：追加到本轮最后一条消息（与 DSH 原生 runtime context 同位置），文本 ≤ 600 token，模板固定：
  ```
  [fastlane plan v<hash>]  steps: 1)… 2)… 3)…
  parallel: <n> 个互不依赖单元 → 必须在同一条消息里发出全部 tool call
  verify: <一条可执行校验>
  ```
- 并行不靠"劝"，靠**两条硬信号**：`parallel: n` 明确写在计划里；`tools/pre-execute` 统计同一条 assistant 消息内的并发 tool call 数，写入 metrics，低于 n 时下一轮在计划尾注追加一行纠偏。
- 复杂任务（预计 ≥ 2 个独立子目标且总步数 ≥ 6）不由本插件调度，直接建议/触发 AgentTeams —— 插件只出"该并行"的判定与 DAG 草稿。

### L3 确定性剪枝 —— 自建 `Service`，写 `compaction/prune`（需求③）

与 billion-context 分工：**它做 LLM 摘要式折叠，我们做零成本规则剪枝，且只剪不接管后端**。
规则（按序，命中即停）：
1. 工具结果超 `thresholdChars`（默认 8192）且匹配日志体特征（连续 3 行以上时间戳/hex/重复栈）→ head 4096 + 标记 + tail 1024（照抄内核 pruner 的 code-point 切法与 `PRUNE_MARKER`）。
2. 同一文件/同一命令在本会话内被重复读取（内容哈希相同）→ 旧结果替换为一行 `已读 #<seq>（内容未变）`。
3. 计划块连续 N=6 轮无引用 → 移入 shadow。
4. 时间超过 3 轮且已被后续结果覆盖的中间探查结果 → 折叠为一行结论。
**永不剪**：用户消息、assistant 最终答复、错误行/堆栈、未完成 todo、文件路径与命令原文（逐字保留，供 grep 与复现）。

### 配置骨架

```yaml
enabled: true
router: { trivialMaxChars: 240, cacheSimThreshold: 0.9, planMinSteps: 3, parallelMinUnits: 2, failOpen: true }
selector: { enabled: false, maxPerTurn: 1, timeoutMs: 8000 }
fastlane: { enabled: false, requireThinking: false, minSuccesses: 3, cooldownDays: 7 }
planner: { maxPlanTokens: 600, reinjectOnlyOnChange: true }
pruner: { thresholdChars: 8192, headChars: 4096, tailChars: 1024, minTurnsBeforeFold: 3, neverPrune: [user, final-answer, errors, todos] }
```

### 分期与验收

| 期 | 内容 | 判据 |
|---|---|---|
| P0（影子） | 只装 L0 + metrics，不改任何消息，跑 2 天 | 分类分布可读；误判（人工抽检 30 条）< 3%；不增加首 token 延迟 |
| P1 | L2 计划尾部注入 + 并行信号 | 多步任务中"同一消息内并发 tool call"的比例相对基线 +30%；前缀命中率不下降（对照 `token-meter` 与 `/acp-cache`） |
| P2 | L3 剪枝 | 平均每次请求输入 token 相对基线 −25%；路径/命令/报错抽样 100% 完整；无回放错误 |
| P3 | L1 答案复用（先 3 个高频 pattern） | 命中 pattern 的第二次起模型回调 = 0；被纠正率 < 5%；否则自动 demote |

目标口径：缓存命中输入 token 占比 ≥ 90%；相同 pattern 的重复任务回调数为 0；普通任务首 token 延迟增幅 ≤ 5%。

### 风险与边界
1. **系统提示每轮变动** → 缓存全废。L2 因此严格把变量放尾部。
2. **换模型换路由** → 缓存作废且 `agent/request` 抛错。需求①若想要"简单任务用便宜模型"，必须走 `agent.model.select()` 且**接受每次切换清零缓存**；默认策略应为"单模型 + 缩短输出"，并行度>模型切换。
3. **压缩抢占** → 与 billion-context 的 `bili-compaction-gate` 冲突会让会话创建 pending；L3 只发 `compaction/prune`，不 disable `compaction-basic`。
4. **答案复用答错** → provenance + 纠正即 demote + 默认关闭（P3 前 `fastlane.enabled=false`）。
5. **分类误判** → fail-open 到 `normal`，永不阻塞；灰区才允许一次 selector。
6. **计费不可见** → 一律以 `token-meter` 的 `cacheReadTokens/uncachedInputTokens` 为准，不依赖代理层自报。

---

## 5. 若要"改造现有插件"而不是自建，需要补的能力（对应你的第三问）

| 插件 | 使其满足需求所需的修改 |
|---|---|
| billion-context | ① 暴露"本轮压缩预算/下一次 nudge 阈值"的可编程接口（现只有 `compress.nudgeGrowthTokens` 全局值）；② 在 `compaction/*` 前留本地 pruner 钩子（先确定性剪、再摘要）；③ 把 `/acp-cache` 的逐请求归因开放成插件可读 API（现在只有命令与 web 页） |
| planning-with-files | ① 计划从"每轮注入"改为"plan_id 变化才注入"，且注入位移到尾部消息；② 完成门与 fast-path 互斥（命中缓存答案时不得再要求写计划）；③ 提供"计划 → 并行意图"字段 |
| @aiwayds/dsh-dcp | 提供"只做 pruner、不 disable `compaction-basic`"模式，否则无法与 billion-context 共存 |
| dsh-routing-suite | ① 分类结果对外可读（当前只在自身 preset 的 system prompt 内自用）；② 增加 `direct-fast` 档与"可跳过模型"的出口；③ 支持在现有 preset 组合上叠加而非整体替换 |

---

## 6. 一句话结论

需求③已有成熟件（billion-context）可用，别再装第二个压缩后端；需求①②在生态里只有半成品，且它们的注入方式会破坏需求①赖以成立的缓存前提 —— 所以正确做法是自建 `dsh-fastlane`：**分类在 `agent/pre-step`、复用走 `llm/stream`、计划只追加到尾部且按 hash 去重、剪枝只发 `compaction/prune`**，四层各自可关、可影子运行、可回滚。

---

## 7. P0 已落地（2026-11-27）

代码：`plugins/dsh-fastlane`（`package.json` + `cordis.patch.yml` + `lib/classify.mjs` + `lib/index.js` + `scripts/aggregate.mjs` + `test/classify.test.mjs` + `README.md`）。已以 `link:` 方式装进 profile `desktop`，entry `include:dsh-fastlane` phase=active。

与方案的一处偏离：**分类器挂在 `llm/stream` 而不是 `agent/pre-step`**。原因是 `agent/pre-step` 的 payload 没有 session 身份，也没有 usage，影子期无法把"路由判定"与"真实 token/缓存/延迟"对齐；而 `llm/stream` 两者都有，且包裹是纯透传、不改消息与请求头，缓存安全性与原生一致。L1 计划注入仍按原方案走 `agent/pre-step`。

实测结论（详见插件 README）：
- 子代理的模型调用**在监听范围内**，以自己的 `sessionId` 独立成条（spawn 子代理 7 条消息 → `decision=turn`）。
- 调用方普遍在 `finish` 处提前退出（生成器走 `return()`），因此"流结束"不能靠循环自然结束来判定，记录必须写进 `finally`，并带 `abandoned` 标记。
- 实测 `cache-hit = cacheRead/(input+cacheRead+cacheWrite)` 落在 95.8%–99.3%，与 billion-context 声称的 96–99% 前缀命中一致；`TokenUsage.inputTokens` 是**未命中**输入（`dsh-token-meter/lib/index.js:328-332`），按它做分母会把命中率算错一个数量级。
- 分类器在真实请求上把"带文件枚举/多步指令"判成 `plan`（score 4.5），把普通提问判成 `normal`（score 0–1）；9/9 单测通过。
- 本地 `link:` 插件不要依赖 `@deepseek-ai/schemastery`：真实路径解析找不到 profile 的 `node_modules`，会 `ERR_MODULE_NOT_FOUND` 让整个 bundle 静默不加载。省略 `Config` 导出即可（Cordis 只在声明 schema 时校验）。

待办：累积真实用户回合样本后判误判率（目标 <3%），再决定 P1 是否启用。

## 8. P1–P4 已落地并跑通（2026-11-27 晚）

`mode: active` 全量运行一轮后的 `aggregate.mjs`：`records 19293 / turns 72 / steps 276 / auxiliary 327`。

| 层 | 实现 | 实测 |
|---|---|---|
| L1 计划 | `agent/pre-step` 在回合首步把 `source.kind='plan-mode'` 的计划消息追加到 `messages` 尾部，`plan_id`（sha256 前 12 位）去重 | `plan` 路由 5 回合（6.9%，score 6.00/置信 0.94），注入 2 次、2 份不同计划；指令含 steps / parallel / verify / rules |
| L2 并行 | 计划指令点名互不依赖单元，要求"必须在同一条 assistant 消息里并行发出这些调用" | 全量并行比 2/51 = 3.9%，作为基线记录（多数回合本身无可并行单元） |
| L3 剪枝 | `tools/result` 节流 → `session.append('compaction/prune', …)` + `surfaceOp: replace`，折叠"晚出现的那份重复"以少作废缓存前缀 | 首轮 landed 1、裁掉 9134 字符；子代理上下文里实测出现 `…[fastlane pruned 9166 chars]…` |
| L4 复用 | `llm/stream` 命中 pattern 直接合成流（reasoning + text + `finish`，不发 usage） | 同题第 3 次命中：子代理收到模板文本与 `fastlane reuse: pattern zebra-smoke v1` 尾注，未调模型；验证后已把 `reuse.enabled` 改回 false |

实现期发现的四件事（都已修，且是后续维护必须知道的）：

1. `agent/pre-step` 的 `step` 是**会话生命周期步号**（新会话第 1 步=1），不是回合内步号；`payload.messages` 只是本次 claimed 的新消息。判"回合开头"只能用 `messages.length > 0`。
2. claimed 消息可能是系统通知（`subagent-settled`、`agent-message`、`plan-mode`、`runtime-context`），必须按 `source.kind` 过滤，否则子代理完成通知会被当成新任务、注入一份计划。
3. 辅助调用（auto-review 等）也走 `llm/stream`，带 `purpose`。L4 若不跳过它们，reviewer 会收到模板散文并报 `Unexpected token ... is not valid JSON`；重复计数也必须排除辅助调用，否则主会话与子代理互相污染。
4. 重复计数以 `sessionId + repeatKey` 为键：跨会话共享计数会让"第 3 次同题"的判定漂移到别的会话去。

仍待观察：L2 的并行比需要"有并行价值"的样本对照（当前样本多为单步工具调用）；L3 的 `minTurnsBeforeFold=3` 让短会话几乎不触发（刻意，但意味着收益只在中长会话显现）；L4 需要先由 `scripts/mine.mjs` 出候选、人工审阅后写 `patterns.json`，并统计纠正率。
