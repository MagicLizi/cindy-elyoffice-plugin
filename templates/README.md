# Blank documents from ElyOffice

`new.docx`, `new.xlsx` and `new.pptx` are the blank files ElyOffice ships for Explorer's **New** menu,
taken unchanged from [ELY-Open-Source/ElyOffice](https://github.com/ELY-Open-Source/ElyOffice) at commit
`8476c76f3b6d72fe5d5e857443bf8bdd2e8b585b` (`packaging/windows/new/`). They are byte-identical to the
files installed with ElyOffice 0.1.17. ElyOffice is MIT-licensed; its license is in `LICENSE-ElyOffice.txt`.

`node/ooxml.cjs` uses them as the base when the AI creates a document, then adds the requested sheets,
paragraphs or slides.

| File | SHA-256 |
| --- | --- |
| `new.docx` | `812312f32444ad291c758e07f0be9ab0c49c83793e16b3183ec356676c999a8c` |
| `new.xlsx` | `4fdc4eaa6ca053ef0833db14d44fff5aeded925b290eb361684848eb1115cb5e` |
| `new.pptx` | `d1d98e136e2c81d30311103ca051fc53b379aa909d0b633f7d3836d3f54c5388` |
