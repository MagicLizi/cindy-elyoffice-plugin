# ElyOffice for Cindy

A [Cindy](https://github.com/makecindy/cindy) plugin that brings [ElyOffice](https://github.com/ELY-Open-Source/ElyOffice), a free, open-source, offline office suite, into Cindy.

- **One-click install**: the plugin settings install the latest ElyOffice for you. Nothing to find or download by hand.
- **AI writes and edits in the window you are looking at**: ask Cindy to create or change a Word, Excel, PowerPoint or Markdown file, and the change appears in the ElyOffice window right away. Every change can be undone with Ctrl+Z, and saving stays your call unless you turn on auto-save. PDFs open in ElyPDF for viewing.

## Opening Office files from Cindy

When you open a Word, Excel or PowerPoint file from Cindy with your default app (Open in a preview, "Open with default app", the file browser), it opens in ElyOffice instead. That covers `.docx`, `.doc`, `.xlsx`, `.xls`, `.csv`, `.pptx`, `.ppt` and their OpenDocument and template variants; PDFs are left alone. Files from other computers, and anything ElyOffice can't open, still go to your default app. You can turn this off under **Configuration** in the plugin's details.

This needs a Cindy version that supports plugin file openers (`fileOpener`). Older versions keep the declaration but don't use it; everything else in the plugin still works.

## What you can ask

- "Open the quarterly report in ElyOffice."
- "In this document, change TODO to 1280 and the owner to Li Si."
- "Put 60 in Sheet1!B3 and a profit formula in B4."
- "Replace the date on every slide with 2026."
- "Create a November budget in ElyOffice with Overview, Budget and Transactions sheets, and fill in sample data."
- "Write meeting minutes as a Word document and open it in ElyOffice."
- "Copy the spreadsheet you just made to my desktop and open it in ElyOffice so I can keep editing."

You don't have to mention ElyOffice. Whenever you ask Cindy to make or edit a Word, Excel, PowerPoint or Markdown document, such as "make a spreadsheet of this month's spending", it uses ElyOffice by default and opens the result for you. When the document needs formatting that ElyOffice doesn't yet expose to AI, Cindy creates the file with another tool first and then opens it in ElyOffice.

## Installing ElyOffice

Open **Plugins → ElyOffice** and choose **Install ElyOffice**.

1. The plugin reads the latest release manifest from ElyOffice's official GitHub releases and checks its **ed25519 signature** against ElyOffice's release key. Nothing is downloaded if the signature does not match.
2. The installer is downloaded through Cindy, with progress, retries and resume, and verified against the **SHA-256** in the signed manifest.

Checking for a new version does not use the GitHub API, whose anonymous limit (60 requests an hour per network) is easily used up on shared VPN or proxy connections. The result is kept for 6 hours, and a failed check is not repeated for 10 minutes unless you ask. Only older Cindy versions, whose downloads need the exact file size up front, look up that size once through the GitHub API when you install or update. If the automatic download still fails, the settings page links to the ElyOffice installer so you can install it yourself; it is recognized when you return to the page.
3. On Windows the installer runs silently for the current user, with no administrator rights and no windows. On macOS the system installer opens and asks for your password once.

ElyOffice installs its apps (about 1 GB) and starts its document engines at login so files open faster. You can uninstall ElyOffice from the same page.

| Platform | Install from the plugin | Use with AI |
| --- | --- | --- |
| Windows x64 | Automatic | Yes |
| macOS | Opens the system installer | Yes (not yet tested on a Mac) |
| Linux | Install ElyOffice yourself | Detected if `ely-doc` is on PATH (not yet tested) |

## Tools for AI

| Tool | What it does |
| --- | --- |
| `elyoffice_status` | Whether ElyOffice is installed, its version, and which files are open |
| `open_document` | Opens a Word, Excel, PowerPoint, Markdown or PDF file in ElyOffice, optionally in a new window |
| `create_document` | Creates a Word document (with paragraphs and headings), a workbook (with several sheets), a deck (with text on each slide) or a Markdown file and opens it; can also copy a finished document and open the copy |
| `read_document` | Reads Word body text, the text on each slide, or Markdown source |
| `replace_text` | Replaces text in Word, PowerPoint or Markdown (Markdown matches can span lines) |
| `read_cells` / `write_cells` | Reads or writes Excel cells or ranges, including formulas |
| `write_table` | Fills a block of rows from one starting cell and reports formula results |
| `save_document` | Saves the file, only when you ask |

The AI workflow, saving rules and error handling are in the bundled manual (`manual/guide`).

**Limits.** ElyOffice itself can do nearly everything in its windows, but the command line it offers to other programs only reads and writes text and cells and saves; the plugin uses all of that. So once a document is open, the AI can change only text and cells. Formatting and adding or removing paragraphs, sheets, rows or slides are things ElyOffice can do but does not yet expose to the AI; you can still do them in the window. The AI also cannot read footnotes, comments, text boxes or speaker notes. That is why sheets, paragraphs and slides are set when a document is created. For a document that needs layout and styling, make it with another tool first and let the plugin copy it into ElyOffice. PDFs are view-only. The plugin works only on files that are on the computer where it runs.

## Permissions

- **Runs local programs** (Node worker): detects ElyOffice, runs its installer, runs its `ely-doc` / `ely-table` / `ely-show` / `ely-mark` command line, and creates new files where you or the AI choose (never over an existing file).
- **Network**: `github.com` and GitHub's release download hosts, to check versions and download ElyOffice; `api.github.com`, only on older Cindy versions, to read the installer size.
- **Notifications**: tells you when the installation finishes.

## Development

```sh
node --test test/*.test.cjs
```

Package and install with Cindy's plugin tools (`ghost_forge_pack` / `ghost_forge_install`). Releases are tagged `v<version>` with `elyoffice-<version>.cindy` attached; Cindy checks this repository for updates through `githubRelease` in `ghost.json`.

## License

The plugin is licensed under Apache-2.0. ElyOffice is a separate project under the MIT license, and its bundled third-party components keep their own licenses (for example, MuPDF in ElyPDF is AGPL-3.0). This plugin does not redistribute ElyOffice; it downloads it from ElyOffice's official releases. The only ElyOffice files it bundles are three blank documents in `templates/` (MIT; see the README there for their source), used as the base for new documents. The icon is the ElyOffice logo from the [ElyOffice repository](https://github.com/ELY-Open-Source/ElyOffice) and belongs to the ElyOffice project.
