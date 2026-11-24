# ElyOffice for Cindy

A [Cindy](https://github.com/makecindy/cindy) plugin that brings [ElyOffice](https://github.com/ELY-Open-Source/ElyOffice), a free, open-source, offline office suite, into Cindy.

- **One-click install**: the plugin settings install the latest ElyOffice for you. Nothing to find or download by hand.
- **AI edits in the window you are looking at**: ask Cindy to change a Word, Excel or PowerPoint file, and the change appears in the ElyOffice window right away. Every change can be undone with Ctrl+Z, and saving stays your call unless you turn on auto-save.

## Opening Office files from Cindy

When you open a Word, Excel or PowerPoint file from Cindy with your default app (Open in a preview, "Open with default app", the file browser), it opens in ElyOffice instead. That covers `.docx`, `.doc`, `.xlsx`, `.xls`, `.csv`, `.pptx`, `.ppt` and their OpenDocument and template variants; PDFs are left alone. Files from other computers, and anything ElyOffice can't open, still go to your default app. You can turn this off under **Configuration** in the plugin's details.

This needs a Cindy version that supports plugin file openers (`fileOpener`). Older versions keep the declaration but don't use it; everything else in the plugin still works.

## What you can ask

- "Open the quarterly report in ElyOffice."
- "In this document, change TODO to 1280 and the owner to Li Si."
- "Put 60 in Sheet1!B3 and a profit formula in B4."
- "Replace the date on every slide with 2026."

## Installing ElyOffice

Open **Plugins → ElyOffice** and choose **Install ElyOffice**.

1. The plugin reads the latest release manifest from ElyOffice's official GitHub releases and checks its **ed25519 signature** against ElyOffice's release key. Nothing is downloaded if the signature does not match.
2. The installer is downloaded through Cindy, with progress, retries and resume, and verified against the **SHA-256** in the signed manifest.
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
| `open_document` | Opens a Word, Excel or PowerPoint file in ElyOffice |
| `read_document` | Reads Word body text or the text on each slide |
| `replace_text` | Replaces text in Word or PowerPoint |
| `read_cells` / `write_cells` | Reads or writes Excel cells, including formulas |
| `save_document` | Saves the file, only when you ask |

The AI workflow, saving rules and error handling are in the bundled manual (`manual/guide`).

**Limits.** ElyOffice's command line changes text and cells only. It cannot change formatting, add or remove paragraphs, rows or slides, or read footnotes, comments, text boxes or speaker notes. The plugin works only on files that are on the computer where it runs.

## Permissions

- **Runs local programs** (Node worker): detects ElyOffice, runs its installer and its `ely-doc` / `ely-table` / `ely-show` command line.
- **Network**: `github.com`, `api.github.com` and GitHub's release download hosts, to check versions and download ElyOffice.
- **Notifications**: tells you when the installation finishes.

## Development

```sh
node --test test/*.test.cjs
```

Package and install with Cindy's plugin tools (`ghost_forge_pack` / `ghost_forge_install`). Releases are tagged `v<version>` with `elyoffice-<version>.cindy` attached; Cindy checks this repository for updates through `githubRelease` in `ghost.json`.

## License

The plugin is licensed under Apache-2.0. ElyOffice is a separate project under the MIT license, and its bundled third-party components keep their own licenses (for example, MuPDF in ElyPDF is AGPL-3.0). This plugin does not redistribute ElyOffice; it downloads it from ElyOffice's official releases. The icon is the ElyOffice logo from the [ElyOffice repository](https://github.com/ELY-Open-Source/ElyOffice) and belongs to the ElyOffice project.
