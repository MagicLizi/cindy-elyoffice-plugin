# 用 ElyOffice 读改 Word、Excel、PPT

目标体验：像一位同事在用户旁边、在同一个文档里帮忙改。改动直接出现在用户的 ElyOffice 窗口里，
看得见、能撤销，保存由用户决定。

## 什么时候用

- 用户点名 ElyOffice，或要求「打开给我看」「在窗口里改」。
- 用户要改的 Word、Excel、PPT 已经开在 ElyOffice 里。不确定时先调
  `elyoffice_status`，看 `openDocuments`。文件开着时，不要用其它方式直接写这个文件：
  ElyOffice 不会覆盖被外部改过的文件，只会造成冲突。
- 用户只要一份新生成的文档、不需要在 ElyOffice 里查看时，不必用本插件。

## 标准流程

1. 不确定文件是否开着时，调 `elyoffice_status`。
2. 读内容：Word / PPT 用 `read_document`；Excel 用 `read_cells`（地址写明工作表名，如 `Sheet1!B2`）。
   文件没开着时这些工具会先打开它，窗口会弹到用户屏幕前面，这是预期行为。
3. 改内容：Word / PPT 用 `replace_text`（可一次传多项）；Excel 用 `write_cells`。
   `find` 必须逐字照抄 `read_document` 读到的原文。
4. 回复用户：说清改了哪几处（用返回的 `replaced` 数和单元格结果），并告诉用户在 ElyOffice 里按
   Ctrl+Z（macOS 为 Cmd+Z）可以撤销。`replaced` 为 0 的项要如实说明没找到。
5. 保存：看返回的 `saved`。
   - `saved` 为 false：提醒用户检查后按 Ctrl+S（macOS 为 Cmd+S）保存，或说「保存」让你调用
     `save_document`。不要擅自保存，保存会把用户自己还没存的改动一起存进去。
   - `saved` 为 true：用户开启了「AI 改完自动保存」，告诉用户已经保存。

## 做不到的事和替代办法

- 改格式（加粗、字号、颜色、对齐）、增删段落、表格行列或幻灯片、插入图片：ElyOffice 命令行不支持。
  直接告诉用户，并给两个选择：
  1. 用户在 ElyOffice 窗口里自己改；
  2. 用户先保存并关闭这个文档，再由你用其它工具直接改文件，改完用 `open_document` 重新打开给用户看。
- 读不到：Word 的脚注、批注、文本框、已删除的修订，PPT 的备注。涉及这些内容时要如实说明。
- 替换只在同一段内匹配，区分大小写；一处原文跨了两段时，需要分成两次替换。

## 常见错误

| 错误码 | 怎么办 |
| --- | --- |
| `ELYOFFICE_NOT_INSTALLED` | 请用户打开「插件 → ElyOffice」设置页一键安装，装好后再试 |
| `FILE_NOT_FOUND` | 文件不在装有插件的这台电脑上（例如任务文件在另一台电脑），本插件处理不了 |
| `UNSUPPORTED_FILE_TYPE` | 不是 Word、Excel、PPT 文件 |
| `OPEN_TIMEOUT` | 文件较大还在载入，或窗口里有需要用户确认的提示；请用户看一眼 ElyOffice 窗口 |
| `DOCUMENT_NOT_OPEN`、`ELYOFFICE_NOT_RUNNING` | 用户关掉了窗口；需要时重新 `open_document` |
| `DISK_CHANGED` | 文件被别的程序改过，ElyOffice 没有覆盖；请用户在 ElyOffice 窗口里决定保留哪个版本 |
| `INVALID_ADDRESS` | 单元格地址缺工作表名，改成 `Sheet1!B2` 这样的写法 |
