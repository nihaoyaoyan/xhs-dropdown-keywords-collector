# 对抗式审查报告

审查对象：小红书下拉词批量采集器（Chrome MV3）
审查方法：以攻击者/边界输入视角枚举失败面，逐条验证修复或记录残留风险。
测试：`tests/adversarial.test.js`（19 项不变量，全过）

## 第一性原理拆解（三个维度）
1. **数据如何流动**：popup → background(SW) → content(页面 DOM) → 回流 SW → 回流 popup。任一跳断裂都致空结果或假完成。
2. **状态如何存活**：MV3 service worker 会被 Chrome 在空闲时回收，长任务不能依赖 SW 内存常驻。
3. **DOM 如何响应**：合成 input 事件能否真正触发小红书(Vue)联想请求，决定自动模式是否可用。

## 已修复（对应攻击面）
| # | 攻击/失败面 | 修复 |
|---|---|---|
| 1 | 残留下拉误读：上一词的联想框未消失，下一词读到旧数据 | `waitClear` 清空后等旧下拉消失再输入 |
| 2 | 半加载下拉：读到不完整联想 | `waitForSuggestions` 连续两帧数量稳定才返回 |
| 3 | MV3 SW 被回收致长任务中断 | keepalive 长连接保活；delay 钳制 ≤15s |
| 4 | 未登录/搜索框未渲染即采集，静默失败 | `ping` + `waitReady` 预检，区分未登录 |
| 5 | 风控/验证码：持续空结果仍狂跑 | 连续 5 次空结果自动暂停并提示 |
| 6 | 用户关掉小红书标签页，任务空转 | 失败后 `tabExists` 检测，终止并提示 |
| 7 | 进度条随递归队列增长而倒退/超 100% | background 统一算 `pct` 并封顶 99% |
| 8 | 本地恢复 + 实时推送竞态致结果重复 | `wordsSet` 全局去重 |
| 9 | Excel 公式注入（`=cmd|...`） | `csvCell` 对 `= + - @` 开头加单引号 |
| 10 | XSS：页面/用户数据注入弹窗 | 全部经 `escapeHtml` 渲染 |
| 11 | 重复启动并发 | SW 端 `job.running` 守卫 |
| 12 | 大数据渲染卡顿 | 表格仅渲染最近 500 条 |
| 13 | 合成输入异常未捕获致无响应 | collectFor/collectCurrent try-catch 回传 error |
| 14 | delay 非法/过大 | 钳制 300–15000ms |
| 15 | 导出失败无反馈 | `chrome.downloads` lastError 提示 |
| 16 | 重开弹窗丢失"运行中"态 | storage 恢复 + `job.running` 检测 + 重连保活 |

## 残留风险（需使用者知晓）
- **DOM 改版**：小红书改版可能使 `SELECTORS` 全失效。缓解：多选择器兜底 + 主路径网络拦截（`inject.js` 截联想响应）；彻底失效时改 `content.js` 的 `SELECTORS`。
- **合成输入不触发联想**：极端环境若小红书校验 `isTrusted` 或走 IME 组合事件，自动模式可能采空。缓解：内置「采集当前下拉」手动兜底。

## v1.9 第一性原理修复（原残留风险已消灭）
- **弹窗关闭 + 长任务：✅ 已消灭（根因是状态模型不可恢复）**
  原 `job` 活 SW 内存里，`saveState` 只存摘要，SW 回收即队列全丢。v1.9 改为 `chrome.storage` 为唯一事实源（queue/visited/added 全序列化），步进式 `pumpJob` 每词落盘，靠 `chrome.alarms`('job-pump' 每 30s) 在 SW 死后/弹窗关闭/浏览器重启后续跑，无需 offscreen document。
- **depth=3 队列规模：✅ 已消灭** — 递归队列硬上限 `QUEUE_CAP=3000`，触顶标记 `truncated` 并在历史里提示。
- **极大导出失败：✅ 已消灭** — `download()` 改用 Blob URL（兜底 data URI）。
- **无图标：✅ 已消灭** — 生成品牌色 (#FF2442) PNG 图标 16/48/128 并接入 manifest。
- **activeTab 权限**：可进一步精简（content_scripts 已注入），当前保留无害。

## 不变量测试结果
```
19 passed, 0 failed
覆盖：CSV 注入、进度封顶、去重、精确匹配过滤、delay 钳制
```
