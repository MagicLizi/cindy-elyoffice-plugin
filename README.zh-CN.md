# ElyOffice for Cindy

把 [ElyOffice](https://github.com/ELY-Open-Source/ElyOffice)（免费、开源、离线的办公软件）接进 [Cindy](https://github.com/makecindy/cindy) 的插件。

- **一键安装**：在插件设置里点一下，就会装好最新版 ElyOffice，不用自己找、自己下。
- **AI 直接在你看着的窗口里写、里改**：让 Cindy 新建或修改 Word、Excel、PPT、Markdown，改动马上出现在 ElyOffice 窗口里，每一处都能按 Ctrl+Z 撤销；保存由你决定，也可以打开自动保存。PDF 可以用 ElyPDF 打开查看。

## 在 Cindy 里打开 Office 文件

在 Cindy 里用默认应用打开 Word、Excel、PPT 文件时（预览里的「打开」、「用默认应用打开」、文件浏览器），会改用 ElyOffice 打开。覆盖 `.docx`、`.doc`、`.xlsx`、`.xls`、`.csv`、`.pptx`、`.ppt` 以及对应的 OpenDocument 和模板格式；PDF 不接管。其他电脑上的文件、ElyOffice 打不开的文件，仍用默认应用打开。可以在插件详情的「配置」里关掉。

这需要支持插件接管打开文件（`fileOpener`）的新版 Cindy。旧版 Cindy 会保留这项声明但不使用，插件其他功能照常可用。

## 可以这样说

- 「用 ElyOffice 打开季度报告。」
- 「把这份文档里的 TODO 改成 1280，负责人改成李四。」
- 「Sheet1 的 B3 填 60，B4 写利润公式。」
- 「把每页幻灯片上的日期都改成 2026 年。」
- 「在 ElyOffice 里新建一个 11 月预算表，分概览、支出预算、收支明细三张表，把示例数据填进去。」
- 「写一份会议纪要的 Word，在 ElyOffice 里打开给我看。」
- 「把刚才做好的表格复制到桌面，用 ElyOffice 打开，我接着改。」

不提 ElyOffice 也可以：只要是做或改 Word、Excel、PPT、Markdown，比如「做个本月开销统计表」，Cindy 会默认用 ElyOffice 完成并打开给你。需要排版、配色这类 ElyOffice 暂时没开放给 AI 的格式时，Cindy 先用其他工具生成文件，再在 ElyOffice 里打开。

## 安装 ElyOffice

打开「插件 → ElyOffice」，点「安装 ElyOffice」：

1. 插件从 ElyOffice 官方 GitHub 发布页读取最新版本清单，用 ElyOffice 的发布密钥核对 **ed25519 签名**，对不上就停止，不下载任何东西。
2. 安装包通过 Cindy 下载，有进度、会重试、能续传，下载完按签名清单里的 **SHA-256** 核对。

检查新版本不使用 GitHub API：它对未登录的查询按网络每小时只给 60 次，用 VPN、代理等共用网络时很容易被用完。查到的结果保留 6 小时，查询失败后 10 分钟内不会自动重查（你点「检查更新」或「重试」除外）。只有旧版 Cindy 下载前需要事先知道安装包的准确大小，安装或更新时才会通过 GitHub API 查一次。自动下载实在失败时，设置页会给出 ElyOffice 安装包的下载链接，自己下载安装后回到设置页即可自动识别。
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
| `open_document` | 用 ElyOffice 打开 Word、Excel、PPT、Markdown 或 PDF 文件，可选新窗口 |
| `create_document` | 新建 Word（带段落和标题）、Excel（带多张工作表）、PPT（带每页文字）或 Markdown 并打开；也可以复制一份已做好的文档再打开 |
| `read_document` | 读取 Word 正文、每页幻灯片的文字或 Markdown 原文 |
| `replace_text` | 替换 Word、PPT 或 Markdown 里的文字（Markdown 可跨行） |
| `read_cells` / `write_cells` | 读写 Excel 单元格或区域，支持公式 |
| `write_table` | 从一格起整片写入表头和多行数据，并检查公式结果 |
| `save_document` | 保存文件，只在你要求时使用 |

AI 的完整使用流程、保存规则和错误处理写在随包手册里（`manual/guide`）。

**能力边界**：ElyOffice 窗口里几乎什么都能做，但它开放给外部程序的命令行只有读写文字、单元格和保存，插件用到的就是这部分的全部能力。所以文档打开后，AI 只能改文字和单元格；改格式、增删段落、工作表、表格行或幻灯片这些，ElyOffice 本身能做，只是还没开放给 AI，可以在窗口里手动做。AI 也读不到脚注、批注、文本框和演讲者备注。新建时要一次给全工作表、段落和幻灯片。需要排版和配色的文档，可以先用其他工具做好，再让插件复制一份用 ElyOffice 打开。PDF 只能查看。插件只能处理它所在这台电脑上的文件。

## 权限

- **运行本机程序**（Node 后台）：检测 ElyOffice、运行它的安装程序，调用 `ely-doc` / `ely-table` / `ely-show` / `ely-mark` 命令行，以及在你或 AI 指定的位置新建文件（不会覆盖已有文件）。
- **网络**：`github.com` 和 GitHub 的发布下载域名，用于检查版本、下载 ElyOffice；`api.github.com` 只在旧版 Cindy 上用来读取安装包大小。
- **通知**：安装完成时提醒你。

## 开发

```sh
node --test test/*.test.cjs
```

用 Cindy 的插件工具打包和安装（`ghost_forge_pack` / `ghost_forge_install`）。发布时打 `v<版本>` 标签，并附上 `elyoffice-<版本>.cindy`；Cindy 通过 `ghost.json` 里的 `githubRelease` 从本仓库检查更新。

## 许可证

本插件使用 Apache-2.0 许可证。ElyOffice 是独立项目，使用 MIT 许可证，其中的第三方组件沿用各自的许可证（例如 ElyPDF 使用的 MuPDF 是 AGPL-3.0）。本插件不分发 ElyOffice，而是从 ElyOffice 官方发布页下载；只随包带了 ElyOffice 的三个空白文件（`templates/`，MIT 许可证，来源见其中的 README），用作新建文档的底稿。插件图标是 [ElyOffice 仓库](https://github.com/ELY-Open-Source/ElyOffice)中的 ElyOffice 标志，归 ElyOffice 项目所有。
