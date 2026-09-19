# 待处理问题清单

> 记录已排查但尚未修复的问题，避免上下文丢失后重复调查。

## P1. 切换主题时面板短暂显示 0 0 0（已定位，未修复）

**现象**：快速切换主题后，统计条偶尔瞬间变成 `0 0 0`，约 1–4 秒后恢复正常。

**已确认的证据**

1. 监控日志（2026-09-19 12:12）：
   ```text
   12:12:20  已推送: 累计 0 tokens，状态 waiting-for-page
   12:12:24  已推送: 累计 532.23M tokens，状态 healthy
   ```
   `waiting-for-page` 在代码里等价于 `activeThreadId()` 返回 `null`。

2. 实机采样（347 次 / 90 秒，250 ms 间隔）证伪了"CDP 目标消失"这一猜想：
   - CDP 连接**全程未断**（0 次 `WS_ERROR` / `EVAL_TIMEOUT` / 重连）
   - `window.__ccmTokenSpendActiveId` **全程未丢失**
   - 页面**未发生导航或重载**

3. 采样还发现：原生锚点（上下文圆圈）不在时，统计条会被**卸载**；
   而页面里的兜底分支要求"主会话区存在"才肯沿用最后确认的 ID
   （`activeThreadId` 内的 `last.id` 判断），主会话区短暂缺失时兜底失效。

**结论**：不是主题判定的问题（`data-theme` 判定全程正确），
而是**「单次探测失败立即归零」**这个设计缺陷——任何亚秒级的 DOM 抖动都会触发。

**尚未拍到**：0 0 0 那一帧的直接抓拍（采样期间面板恰处于卸载状态）。

**修复方向（待执行）**

1. 加滞回：单次探测失败不归零，连续 2 次（约 2 秒）失败才认定"没有对话"
2. 连接/锚点刚丢失时保留上一次有效负载，状态标为"重连中"，超阈值才归零
3. 放宽兜底条件：主会话区短暂缺失时也允许沿用最后确认的 ID

**验收要求**：快速切主题 3 次后日志**不应再出现 `累计 0 tokens`**；
但**真实切换到空白新对话仍必须归零**（这条不能被滞回挡掉，需专门测试）。

---

## P2. 容器重挂载后 ResizeObserver 不再重绑（已定位，未修复）

**代码位置**：`codex-token-spend-panel.js`

- `mount()` 的锚点缺失分支：`if (state.resizeObserver) state.resizeObserver.disconnect();`
  —— 只断开、不置空引用。
- `observeContainer()`：`if (state.container === container && state.resizeObserver) return;`
  —— 把「引用非空」当作「仍在观察」。

**触发路径**：锚点短暂消失（Codex 重渲染）→ `mount()` 走 anchor-missing 分支并 disconnect；
锚点恢复后若挂载容器仍是同一个，`observeContainer()` 因 `state.container === container && state.resizeObserver`
为真而早退 —— observer 保持断开状态、不会重绑。

**实证**：2026-09-19 对照实验（把 `ResizeObserver` 构造改成抛错，再触发重挂载）中，
预期 `mount()` 抛错，实际面板被无缝重新插入且无异常 —— 现象与该早退路径一致
（说明没有发生新的 observer 构造）。

**影响**：容器的尺寸变化不再实时驱动紧凑模式自适应（`window` resize 事件仍是兜底），
属于视觉细节级问题，不影响数据与统计。

**修复方向（待执行）**：锚点缺失分支里把 `state.resizeObserver = null` 一并置空；
或让 `observeContainer()` 用真实的观察状态（如断开时把 `state.container = null`）判定。

---

## P3. 锚点父元素恰为挂载容器时，可能每帧重挂载（✅ 已修复，2026-09-19）

**代码位置**：`codex-token-spend-panel.js` `mount()`

**机制**（收敛条件与失效条件）：

- `findMountPoint()` 从 `ring.parentElement` 起向上（最多 8 层）找第一个 `display:flex`
  且子元素 ≥2 的容器，返回 `{ container, before: ring.parentElement }`；
  正常预期是 **`before` 恰好是 `container` 的直接子元素**。
- `mount()` 用 `state.root.nextSibling !== point.before` 判断「是否需要重新插入」；
  正常结构下第二次 mount 时该条件为假（面板后面正好跟着 `before`）→ 收敛。
- 失效条件（比最初记录更宽）：**只要 `point.before.parentElement !== point.container`**，
  插入分支就会把参考节点降级为 `null`（追加到容器末尾），而下次 mount 的
  `nextSibling(null) !== point.before` 恒为真 → 每帧重挂载：
  appendChild → 产生 mutation → 命中 `state.container.contains(record.target)` → queueMount → 循环。
- 两条触发路径：① `container` 就是 `ring.parentElement`（第 0 层命中，`before === container`）；
  ② `container` 在 `ring.parentElement` 之上、中间还隔着其他层。

**实证**（2026-09-19 两次专项测试，探针计数 = remove + add）：

- 路径 ①（容器即锚点直接父）：2.2 秒内移动 62 次（计数 124）。
- 路径 ②（隔层包裹）：2.5 秒内移动 64 次（计数 128）。
- 两次移除实验节点后都立即收敛（+1 次后停止），面板位置、状态、真实圆圈均正常。

**当前结构为何不触发**：真实结构为 `circle → SPAN → DIV(flex)`，
`before = SPAN` 的父元素正是 `DIV = container` → 收敛（实测无持续移动）。
Codex 改版若「去掉中间 SPAN」或「在中间再加一层」，都会进入上述循环。

**影响**：当（且仅当）圆圈的直接父元素即为挂载容器时，会持续每帧重挂载 ——
视觉位置仍然正确，但伴随持续的 DOM 移动与 render 开销，可能表现为轻微闪烁或 CPU 上升。
当前 Codex 的 `ring → SPAN → DIV(flex)` 结构下**不触发**（实测稳定）。

**修复（2026-09-19 已执行）**：

1. `mount()` 把「是否需要重新插入」的判据归一化 —— 判断与插入使用同一个 `before`：
   `before` 有效时比较 `nextSibling === before`；降级为 `null` 时比较
   `state.root === point.container.lastElementChild`，使循环一次即收敛。
2. `MutationObserver` 加固：忽略「addedNodes 与 removedNodes 都只有 `state.root`」的记录
   （面板自身移动不触发重挂载；被外部移除的场景由更早的 `isConnected` 检查兜底）。

**修复后实测**（与修复前同一实验、同一探针）：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 异常锚点结构（使 `before` 失效） | 2.5 秒内移动 **128 次**（每帧） | **2 次**（一次移动即收敛） |
| 移除实验节点恢复 | +2 | +2 |

面板连接、诊断状态、真实圆圈均正常；语法 / 34 项单测 / 31 项基线 / 五副本一致性全部通过。

---

## P4. TPS（速度）不随数据刷新（✅ 已修复，2026-09-19）

**现象**：详情弹层打开时，「速度」显示不会随数据推送及时刷新（用户于 2026-09-19 报告）。

**已核实的事实**（代码层面，2026-09-19）：

- `codex-token-spend-panel.js` 的 `dataKeyOf()` 只包含 19 个字段，
  **不含** `turnCacheHitRate`、`sessionTps`、`lastRequestTps`、`health.pageAttached`、`health.dataFresh`；
- `DATA_EVENT` 处理器用 `state.dataKey !== previousKey` 门控 `render()`；
  `render()` 的详情框分支同样用 `__ccmRenderedDataKey` 门控。
  → 上述字段单独变化时不会触发渲染（只更新副标题）。
- 注：`requestDetails` / `turns` 的内容变化仅由列表「结构指纹」间接覆盖（指纹不含单项数值）。
- 一处第三方分析的修正：`turnCacheHitRate` 由 `turnInput/turnCached` 推导，二者不变时它也不会变，
  因此「命中率单独变化」在原理上不会发生；真实受影响的是 **TPS** 与两个 health 字段。

**修复（2026-09-19 已执行）**：取消渲染门控 ——

1. `DATA_EVENT` 处理器：数据事件一律调用 `render()`（不再比较 `dataKey`）；
2. `render()` 的详情框分支：一律走 `renderDetails()`（不再比较 `__ccmRenderedDataKey`）。

渲染路径内部全部是增量更新（实测 <1ms，且写 DOM 前均有 `!==` 检查），空闲时每 5 秒空跑一次的成本可忽略；
今后新增字段也不会再漏。

**决定性与对照测试**（同步派发事件后立即读取，避免被监控的真实推送覆盖造成假阴性）：

| 版本 | 只改 payload 的 TPS 字段（其余不动）后的界面响应 |
| --- | --- |
| 修复前（备份回滚实测） | `reactive: false` —— 48.9/195.6 完全不动（bug 复现） |
| 修复后 | `reactive: true` —— 48.9→159.9、195.6→417.6 立即更新 |

回归：面板挂载正常、弹层开关正常、诊断状态为空、健康 `healthy`、七文件副本一致。

**附：语义说明（非缺陷）**：速度 = 「已完成请求的输出 ÷ 生成耗时」，因此**生成过程中数值保持不动、
请求完成瞬间更新**，这是当初选定的口径（方案甲）；会话累计的"速度"是全会话加权平均，
在长会话中变化本就非常缓慢（1679 次请求后单次请求只影响小数点后一位以内）。

---

## P5. 会话分片（宿主切分文件）导致数据停滞（✅ 已修复，2026-09-19）

**现象**：面板数字从 13:34 起停滞在 590.12M 长达 3.5 小时，健康度仍显示 `healthy`（静默失效）。

**根因**：宿主对超大会话（46.6MB）做「分片」——
新文件名 `rollout-<时间>-<threadId>_<分段UUID>.jsonl`（多下划线后缀、换日期目录，内容从 ordinal 接续）。
监控的 `threadIdOf()` 从文件名提取出**带后缀的 ID**，与页面真实线程 ID 不匹配 →
精确匹配到**已停更的旧分片** → 数据停滞。

**修复（方案 B：多分片合并）**：

1. `threadIdOf()` 剥离 `_<分段UUID>` 后缀（兼容旧命名）；
2. 新增 `locateThreadFiles()`（归组同一会话全部分片、按文件名时间升序）与
   `mergeSegments()`（拼接解析结果；统计层按内容键跨分片去重，重叠区不重复计数）；
3. `readWatchStats()` 重写为「每个分片一个增量解析器 + 合并后统计」，
   所有分片快照引用未变时跳过重复聚合（性能与单文件时持平）；
4. 停滞告警改用**最新分片**的 mtime（最早的旧分片可能早已停更，不能作为判据）。

**验证**：单测 37/37（新增分片归组/合并/后缀剥离 3 个用例）、行为基线 0 不一致、
实机合并验证（真实 2 分片 → 782.3M / 2079 请求 / 173 轮）；
上线后：面板 590.12M → **783.75M**（含 4 小时分片内容）、状态回 `healthy`、停滞告警消失、数字实时增长。

---

## 其他未完成事项（2026-09-19）

1. **深色主题改造尚未提交 git** —— 改动已部署到源码树 / 部署包 / Codex++ 用户脚本三处并实机验证通过，
   但还没有 commit / push，也没有补 README 与 CHANGELOG。
2. **浅色主题未做完整回归** —— 需要把 Codex 切到浅色主题确认视觉不回归
   （当前逻辑是"宿主变量优先"，理论上会跟随）。
3. **Release 未创建** —— 桌面已有干净的安装包 zip（341 KB），tag `1.0.0-alpha` 已存在。
4. **旧状态目录残留** —— `%LOCALAPPDATA%\ccm-token-spend` 的历史日志未清理
   （迁移逻辑在"新目录已存在"时不执行）。
5. **`%TEMP%` 残留** —— 审计脚本报告有若干 `ccm-token-spend-test-*` 临时目录。
6. **CI 依赖升级** —— `actions/checkout@v4` / `setup-node@v4` 的 Node 20 运行时已弃用，可升到 v5。
7. **剩余约 346 行继承代码** —— 尚未整理逐段清单，也未决定"重写 / 取授权"路线。
8. **mount 异常保护已修复，待 git 提交** —— `queueMount()` 增加 try/catch（写 `mount-crashed`
   诊断状态 + 带指引日志 + 显式复位队列），`start()` 初始挂载改走同一路径；已通过
   语法 / 34 项单测 / 31 项行为基线 / 五副本哈希 / 实机对照实验（抛错 → 记录 → 自动重试成功）。
9. **MutationObserver 判定优化（办法 1）已部署，待 git 提交** —— childList 分支增加
   「仅在节点存在元素子节点时才做子树查询」的廉价门控（语义严格等价）；实测纯叶子批次
   耗时约为原实现的 46%，混合批次持平；已通过语法 / 单测 / 基线 / 五副本 / 实机专项验证。
   注：`matches()` 变体经实测在混合场景略慢，未采用。
10. **办法 2（限制子树搜索深度）暂缓** —— 用户决定后续再评估；实测判定开销为微秒级，
    当前无紧迫性。
11. **详情弹层性能优化 + 键盘监听移除已部署，待 git 提交** —— 弹层改为「骨架 + 增量更新」
    （数值更新 0.7ms / 列表重建 6.5~7.5ms，原全量重建 16.9ms），并保持滚动位置与展开状态；
    同时移除全部键盘监听（Enter/空格打开、Esc 关闭），实测详情框打开前后键盘监听器数量零变化。
    遗留待定：统计条仍保留 `role="button"` 与 `tabindex="0"`（可聚焦但已无键盘激活路径），
    是否一并调整由用户决定。
