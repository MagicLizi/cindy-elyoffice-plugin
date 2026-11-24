# ElyOffice for Cindy

把 [ElyOffice](https://github.com/ELY-Open-Source/ElyOffice)（免费、开源、离线的办公软件）接进 [Cindy](https://github.com/makecindy/cindy) 的插件。

- **一键安装**：在插件设置里点一下，就会装好最新版 ElyOffice，不用自己找、自己下。
- **AI 直接在你看着的窗口里改**：让 Cindy 改 Word、Excel、PPT，改动马上出现在 ElyOffice 窗口里，每一处都能按 Ctrl+Z 撤销；保存由你决定，也可以打开自动保存。

## 可以这样说

- 「用 ElyOffice 打开季度报告。」
- 「把这份文档里的 TODO 改成 1280，负责人改成李四。」
- 「Sheet1 的 B3 填 60，B4 写利润公式。」
- 「把每页幻灯片上的日期都改成 2026 年。」

## 安装 ElyOffice

打开「插件 → ElyOffice」，点「安装 ElyOffice」：

1. 插件从 ElyOffice 官方 GitHub 发布页读取最新版本清单，用 ElyOffice 的发布密钥核对 **ed25519 签名**，对不上就停止，不下载任何东西。
2. 安装包通过 Cindy 下载，有进度、会重试、能续传，下载完按签名清单里的 **SHA-256** 核对。
3. Windows 上为当前用户静默安装，不需要管理员权限，也不弹窗口；macOS 上会打开系统安装器，需要输入一次电脑密码。

ElyOffice 装好后约占 1 GB，并会在开机时启动文档引擎，让打开文件更快。在同一个页面也可以卸载 ElyOffice。

| 系统 | 插件安装 | AI 读改 |
| --- | --- | --- |
| Windows x64 | 全自动 | 支持 |
| macOS | 打开系统安装器 | 支持（尚未在 Mac 上实测） |
| Linux | 需自行安装 ElyOffice | `ely-doc` 在 PATH 中时可识别（尚未实测） |

## 给 AI 的工具

| 工具 | 作用 |
| --- | --- |
| `elyoffice_status` | 是否已安装、版本号、当前打开了哪些文件 |
| `open_document` | 用 ElyOffice 打开 Word、Excel、PPT 文件 |
| `read_document` | 读取 Word 正文或每页幻灯片的文字 |
| `replace_text` | 替换 Word 或 PPT 里的文字 |
| `read_cells` / `write_cells` | 读写 Excel 单元格，支持公式 |
| `save_document` | 保存文件，只在你要求时使用 |

AI 的完整使用流程、保存规则和错误处理写在随包手册里（`manual/guide`）。

**能力边界**：ElyOffice 的命令行只能改文字和单元格，不能改格式、增删段落、表格行或幻灯片，也读不到脚注、批注、文本框和演讲者备注。插件只能处理它所在这台电脑上的文件。

## 权限

- **运行本机程序**（Node 后台）：检测 ElyOffice、运行它的安装程序，以及调用 `ely-doc` / `ely-table` / `ely-show` 命令行。
- **网络**：`github.com`、`api.github.com` 和 GitHub 的发布下载域名，用于检查版本、下载 ElyOffice。
- **通知**：安装完成时提醒你。

## 开发

```sh
node --test test/*.test.cjs
```

用 Cindy 的插件工具打包和安装（`ghost_forge_pack` / `ghost_forge_install`）。发布时打 `v<版本>` 标签，并附上 `elyoffice-<版本>.cindy`；Cindy 通过 `ghost.json` 里的 `githubRelease` 从本仓库检查更新。

## 许可证

本插件使用 Apache-2.0 许可证。ElyOffice 是独立项目，使用 MIT 许可证，其中的第三方组件沿用各自的许可证（例如 ElyPDF 使用的 MuPDF 是 AGPL-3.0）。本插件不分发 ElyOffice，而是从 ElyOffice 官方发布页下载。插件图标是 [ElyOffice 仓库](https://github.com/ELY-Open-Source/ElyOffice)中的 ElyOffice 标志，归 ElyOffice 项目所有。
