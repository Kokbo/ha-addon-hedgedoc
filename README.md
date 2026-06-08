# HedgeDoc Sidebar Add-on Repository

This is a Home Assistant add-on repository containing **HedgeDoc Sidebar**, a
native sidebar workspace for Markdown documentation.

## Installation

1. In Home Assistant, go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Open the three-dot menu and choose **Repositories**.
3. Add this repository URL:

   ```text
   https://github.com/Kokbo/ha-addon-hedgedoc
   ```

4. Install **HedgeDoc Sidebar**.
5. Configure `documentation_folders`.
6. Start the add-on and open **Documentation** from the sidebar.

## Add-on

Although the add-on keeps the requested name, the implementation is not a
HedgeDoc fork. HedgeDoc stores notes in a database and exports Markdown as a
secondary copy, which conflicts with the core requirement that `.md` files on
disk remain the authoritative source. This add-on therefore implements a
lightweight filesystem-first editor with a CodeMirror-based UI, live Markdown
preview, file watchers, export/restore, and Home Assistant Ingress support.

See [`hedgedoc_sidebar/DOCS.md`](hedgedoc_sidebar/DOCS.md) for configuration
and architecture details.