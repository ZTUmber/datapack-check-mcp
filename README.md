# datapack-check-mcp

用 [Spyglass](https://spyglassmc.com/) 语言服务器检查 Minecraft Java 版数据包，通过 MCP stdio 把诊断交给任意 MCP 客户端。

复用 VS Code 插件 Datapack Helper Plus背后的同一套引擎：`@spyglassmc/language-server`。拿到的红线与编辑器 Problems 同源。

## 工具

| 工具 | 作用 |
|---|---|
| `check_file` | 检查单个 `.mcfunction` / 数据包 JSON / `.mcmeta` / `.snbt` / `.mcdoc` |
| `check_project` | 检查工作区下全部数据包文件 |

返回 JSON：`path`、`line`、`column`、`severity`、`message`。`ok` 在没有 error 且分析未被取消时为 `true`。

静态检查语法、JSON schema、引用/ID。

## 要求

- Node.js 20+
- 第一次检查会下载原版数据包缓存，可能要几分钟

## 安装

```bash
cd D:\c\datapack-check-mcp
npm install
npm run build
```

任意支持 MCP stdio 的客户端按下面启动即可（配置字段名因客户端而异）：

```json
{
  "command": "node",
  "args": ["D:/c/datapack-check-mcp/dist/index.js"],
  "env": {
    "DATAPACK_WORKSPACE": "D:/path/to/your-datapack-or-workspace"
  }
}
```

`DATAPACK_WORKSPACE` 应指向带 `pack.mcmeta` 的包根，或包含多个包的父目录。不设的话：`check_file` 会从文件向上找 `pack.mcmeta`，`check_project` 用传入的 `root` 或进程 cwd。

## 命令行（不经过 MCP）

```bash
node dist/index.js --check-file test/fixture-pack/data/demo/function/bad.mcfunction
node dist/index.js --check-project test/fixture-pack
```

有 error 时退出码为 `2`。

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `DATAPACK_WORKSPACE` | （推断） | Spyglass 工作区根 |
| `DATAPACK_CHECK_READY_TIMEOUT_MS` | `180000` | 等 Spyglass 就绪（含首次缓存） |
| `DATAPACK_CHECK_FILE_TIMEOUT_MS` | `30000` | `check_file` 等诊断 |
| `DATAPACK_CHECK_LOCALE` | `en` | Spyglass 诊断语言 |

日志打在 stderr，避免污染 MCP/LSP 的 stdout。
