---
name: datapack-check
description: >-
  用 datapack-check MCP（Spyglass / Datapack Helper Plus 引擎）静态检查 Minecraft
  Java 数据包。写、改、修 .mcfunction、pack.mcmeta、数据包 JSON、.snbt、.mcdoc 之后必须调用
  check_file / check_project，禁止凭记忆认定命令或 JSON 合法。用户提到数据包、mcfunction、
  loot table、advancement、predicate、recipe、datapack、Spyglass、DHP 时使用。
---

# 数据包静态检查

检查引擎是 **datapack-check MCP**，底层是 Spyglass，和 Datapack Helper Plus 同源。不要自己解析命令树，不要把游戏里跑一遍当成静态检查。

## 何时调用

改了数据包文件就查。包括：新增/修改 `.mcfunction`、`pack.mcmeta`、`data/**/*.json`、`.snbt`、`.mcdoc`。宣称写完、修好、能用之前必须再查一遍。

纯解释、纯阅读、不改文件：不必调用。

MCP 工具不在当前会话里：停手，告诉用户先启动 `datapack-check` MCP，不要改用猜的语法继续写。

## 工具

| 工具 | 参数 | 用途 |
|---|---|---|
| `check_file` | `path`（文件路径） | 改完单个文件立刻查 |
| `check_project` | `root`（可选，包根或含 `pack.mcmeta` 的目录） | 一批改动结束、或声称完成时查整包 |

`path` / `root` 用绝对路径。`root` 指向带 `pack.mcmeta` 的目录；工作区有多个包时对每个包根各查一次，或指向它们的共同父目录。

第一次调用会拉原版缓存，可能要几分钟。`incomplete: true` 时立刻再调 `check_project`；其它失败不要连着重试一堆。

## 工作流

1. 改文件。
2. 只改了一两个文件：立刻 `check_file`。
3. 一次改了很多文件：**不要**对每个文件串行 `check_file`，改完调一次 `check_project`。
4. 有 error：按 `path` + `line` + `message` 修，再查刚修的那些文件（少量用 `check_file`，仍很多就再 `check_project`）。
5. 返回 `incomplete: true`：Spyglass 还在后台跑。立刻再调一次 `check_project`，不要当成失败，也不要开始改文件。
6. 只有最后一次检查 `ok: true` 且 `incomplete` 不为 true（或只剩用户要保留的 warning）才能说写完了。

## 怎么读结果

JSON 字段：`ok`、`errorCount`、`warningCount`、`diagnostics[]`（`path`、`line`、`column`、`severity`、`message`）。

- `ok: true` 且 `errorCount: 0`：静态语法过了。
- `severity: error`：必须修。
- `severity: warning`：能顺手修就修，不要为消 warning 改原设计。
- 工具返回 `isError` 或 `error` 字段：是 MCP/Spyglass 挂了，不是游戏诊断。报告原文，不要假装检查通过。

## 边界

这是静态检查：命令字、参数形状、JSON schema、部分 ID/引用。

查不出：`execute` 链运行时对不对、选择器实际选中谁、计分板条件成不成立、加载后副作用。那些要进游戏测，别把 `ok: true` 说成「逻辑正确」。

## 禁止

- 用网页记忆或「看起来合法」代替 `check_file`
- 改了文件却只检查其中一个
- 改了一大批文件还逐个 `check_file`，再全包扫一遍（一次 `check_project` 即可）
- 把 warning 当 error 大改结构
- 为了过检查削弱用户要的效果
