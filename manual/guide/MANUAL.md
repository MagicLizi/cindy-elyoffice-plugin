# 用 ElyOffice 新建和读改 Word、Excel、PPT、Markdown

目标体验：像一位同事在用户旁边、在同一个文档里帮忙写、帮忙改。改动直接出现在用户的 ElyOffice
窗口里，看得见、能撤销，保存由用户决定。

## 什么时候用

- 用户点名 ElyOffice，或要求「打开给我看」「在窗口里改」「在 ElyOffice 里做一份」。
- 用户要改的文档已经开在 ElyOffice 里。不确定时先调 `elyoffice_status`，看 `openDocuments`。
  文件开着时，不要用其它方式直接写这个文件：ElyOffice 不会覆盖被外部改过的文件，只会造成冲突。
- 用户只要一份新生成的文档、不需要在 ElyOffice 里查看或继续改时，不必用本插件。

## 插件能做的和只能在窗口里做的

ElyOffice 窗口里几乎什么都能做（格式、插入行列、工作表、图表、图片、批注、版式……），但它开放给
外部程序的命令行只有读写文字、单元格和保存。插件只能经命令行操作，所以能做的是命令行开放的全部能力，
再加上新建文件。和用户说明时要讲清：右列这些 ElyOffice 本身能做，只是还没开放给 AI，用户可以在窗口里
手动做；不要说成「ElyOffice 做不到」。

| 应用 | 插件能做 | 命令行没开放（用户可在窗口里手动做） |
| --- | --- | --- |
| ElyTable（Excel） | 读格、读区域、写格（可多行文字）、整片写入、写公式、保存 | 改格式、加删工作表、插入删除行列、图表、排序筛选 |
| ElyDoc（Word） | 读正文（含表格里的文字）、替换文字、保存 | 改格式、增删段落、插图片；读不到脚注、批注、文本框和图形、已删除的修订 |
| ElyShow（PPT） | 读每页文字、替换文字、保存 | 改格式、增删幻灯片、版式；读不到备注和批注 |
| ElyMark（Markdown） | 读原文、替换（可跨行，所以能增删内容）、保存 | 预览模式下不能改 |
| ElyPDF（PDF） | 打开给用户看 | 读、改、保存（ElyPDF 没有命令行） |

文档打开以后插件不能再加工作表、段落、幻灯片，这些结构必须在 `create_document` 时一次给全。
Word、PPT 的替换文字里不能有换行：ElyOffice 会拒绝，所以不能靠替换来加段落。

## 新建文档

`create_document` 按 `path` 的扩展名决定类型，在磁盘上写新文件并打开。同名文件已存在时返回
`FILE_EXISTS`，绝不覆盖；换个文件名，或用 `open_document` 打开那个已有文件。`path` 只给文件名时，
文件放进用户的「文档」文件夹；用户指定了位置就用用户的。

- **Excel**：`sheets` 列出全部工作表名，再用 `write_table` 逐张填表头和数据。公式按写入后的位置写，
  写完看返回的 `formulaErrors`，有 `#NAME?`、`Err:502` 之类就修正后重写那几格。
- **Word**：`paragraphs` 给出全部段落，标题用 `{ text, style: "title" | "heading1" | "heading2" | "heading3" }`。
  之后只能用 `replace_text` 改已有文字，所以内容尽量一次写全；需要以后补写的地方可以先放占位文字。
- **PPT**：`slides` 给出每一页 `{ title, text }`。第一页是封面，其余页是标题加正文，正文用换行分行。
- **Markdown**：`text` 给出初始原文；之后用 `replace_text` 可以跨行改、增删内容。
- **要格式**（字体、颜色、列宽、表格边框、图表、配图）：先用其他文档工具生成完整文件，
  再 `create_document({ path, from: 生成的文件 })`：插件复制一份到 `path` 并在 ElyOffice 里打开，
  之后照常用本插件读改文字和单元格。`from` 与新文件扩展名必须一致，插件不做格式转换。

`opened` 为 false 时文件已经建好，只是没能打开：把 `openError` 的意思和文件位置告诉用户。

## 读改已有文档

1. 不确定文件是否开着时，调 `elyoffice_status`。
2. 读：Word、PPT、Markdown 用 `read_document`；Excel 用 `read_cells`，可以传区域（如 `Sheet1!A1:F20`），
   一次最多 500 格。文件没开着时这些工具会先打开它，窗口会弹到用户屏幕前面，这是预期行为。
3. 改：Word、PPT、Markdown 用 `replace_text`（可一次传多项），`find` 必须逐字照抄读到的原文；
   Excel 整片填表用 `write_table`，几个分散的格子用 `write_cells`。
4. 回复用户：说清改了哪几处（用返回的 `replaced` 数和单元格结果），并告诉用户在 ElyOffice 里按
   Ctrl+Z（macOS 为 Cmd+Z）可以撤销；Excel 每格是一步撤销。`replaced` 为 0 的项要如实说明没找到。
5. 保存：看返回的 `saved`。
   - `saved` 为 false：提醒用户检查后按 Ctrl+S（macOS 为 Cmd+S）保存，或说「保存」让你调用
     `save_document`。不要擅自保存，保存会把用户自己还没存的改动一起存进去。
   - `saved` 为 true：用户开启了「AI 改完自动保存」，告诉用户已经保存。

`open_document` 传 `newWindow: true` 会在新窗口打开（用户要求时才传；ElyMark 只有一个窗口，会忽略）。

## 做不到的事和替代办法

- 已打开文档的格式（加粗、字号、颜色、对齐、列宽）、增删段落、幻灯片、工作表、表格行列，插入图片：
  ElyOffice 窗口里能做，但命令行没开放给插件。如实告诉用户，并给两个选择：
  1. 用户在 ElyOffice 窗口里自己改；
  2. 用户先保存并关闭这个文档，再由你用其它工具直接改文件，改完用 `open_document` 重新打开给用户看。
- 新文档要格式：按上面「要格式」的做法，先生成再用 `from` 打开。
- 读不到：Word 的脚注、批注、文本框、已删除的修订，PPT 的备注，PDF 的内容。涉及这些内容时要如实说明。
- Word、PPT 的替换只在同一段内匹配，区分大小写；一处原文跨了两段时，需要分成两次替换。

## 常见错误

| 错误码 | 怎么办 |
| --- | --- |
| `ELYOFFICE_NOT_INSTALLED` | 请用户打开「插件 → ElyOffice」设置页一键安装，装好后再试 |
| `FILE_NOT_FOUND` | 文件不在装有插件的这台电脑上（例如任务文件在另一台电脑），本插件处理不了 |
| `FILE_EXISTS` | 新建时同名文件已存在：换个文件名，或用 `open_document` 打开它 |
| `UNSUPPORTED_FILE_TYPE` | 不是这个操作支持的文件类型；PDF 只能用 `open_document` 打开查看 |
| `INVALID_ARGS`、`INVALID_PATH` | 按 message 指出的字段修正参数后重试 |
| `PERMISSION_DENIED` | 没有权限在这个位置建文件，请用户换个位置 |
| `OPEN_TIMEOUT` | 文件较大还在载入，或窗口里有需要用户确认的提示；请用户看一眼 ElyOffice 窗口。Mac 上第一次打开「文稿」「桌面」「下载」里的文件时，macOS 会弹窗问是否允许访问，用户点「允许」后文件会接着载入，再调一次即可 |
| `DOCUMENT_NOT_OPEN`、`ELYOFFICE_NOT_RUNNING` | 用户关掉了窗口；需要时重新 `open_document` |
| `DISK_CHANGED` | 文件被别的程序改过，ElyOffice 没有覆盖；请用户在 ElyOffice 窗口里决定保留哪个版本 |
| `WRITE_FAILED` | 写入的工作表不存在或受保护；`detail.written` 是已写好的格数，可让用户按 Ctrl+Z 撤销 |
| `MARKDOWN_PREVIEW` | ElyMark 正在预览模式，请用户按 Ctrl+/（macOS 为 Cmd+/）切到编辑或源码模式 |
| `INVALID_ADDRESS` | 单元格地址缺工作表名，改成 `Sheet1!B2` 或 `Sheet1!A1:F20` 这样的写法 |
