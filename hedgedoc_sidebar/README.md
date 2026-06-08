# HedgeDoc Sidebar

HedgeDoc Sidebar provides a native Home Assistant sidebar workspace for
Markdown documentation.

Although the add-on keeps the requested name, the implementation is not a
HedgeDoc fork. HedgeDoc stores notes in a database and exports Markdown as a
secondary copy, which conflicts with the core requirement that `.md` files on
disk remain the authoritative source. This add-on therefore implements a
lightweight filesystem-first editor with a CodeMirror-based UI, live Markdown
preview, file watchers, export/restore, and Home Assistant Ingress support.

See [`DOCS.md`](DOCS.md) for installation, configuration, and architecture
details.
