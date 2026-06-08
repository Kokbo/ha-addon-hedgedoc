# HedgeDoc Sidebar

HedgeDoc Sidebar is a Home Assistant add-on that provides a Markdown
documentation workspace directly in the Home Assistant sidebar.

## Architecture decision

The initial requirement asked for HedgeDoc plus direct filesystem-backed
Markdown files. HedgeDoc is intentionally database-centric: notes are stored in
SQLite, PostgreSQL, or MariaDB, while filesystem storage is used for templates,
uploads, static assets, and exports. Making `.md` files on disk the
authoritative source would require replacing HedgeDoc's note, revision,
permission, and realtime collaboration model.

This add-on therefore keeps the requested add-on identity but implements a
filesystem-first Markdown workspace instead:

- Markdown files in configured Home Assistant folders are the source of truth.
- Files are edited in place and remain human-readable and Git-friendly.
- The UI is a custom React application using CodeMirror and Markdown preview.
- The backend exposes a narrow API with strict path validation and filesystem
  watchers.
- Home Assistant Ingress provides authentication and sidebar integration.

This follows the proven add-on pattern used by the VS Code, File Editor, and
Terminal add-ons: run a web service on an internal port, enable Ingress, set the
sidebar title/icon, and mount only the Home Assistant folders that must be
available to the add-on.

## Installation

1. Add this repository as a Home Assistant add-on repository, or copy it into a
   local add-on folder.
2. Install **HedgeDoc Sidebar**.
3. Configure `documentation_folders`.
4. Start the add-on.
5. Open **Documentation** from the Home Assistant sidebar.

No manual port exposure is required.

## Configuration

```yaml
site_name: Home Documentation
storage_mode: filesystem
documentation_folders:
  - /config/docs
  - /config/packages/documentation
allow_uploads: true
max_upload_size: 25
database_type: sqlite
enable_file_watchers: true
```

### `storage_mode`

- `filesystem` (recommended): edits `.md` files directly in configured folders.
- `database`: stores Markdown documents in `/data/documentation.sqlite`. This
  mode is included for users who want database-backed notes, but it is not the
  recommended Git-friendly workflow.

### `documentation_folders`

Only folders listed here are accessible. The add-on creates missing folders at
startup and recursively discovers `.md` files. Supported Home Assistant mount
locations are `/config`, `/share`, `/media`, and `/backup`.

Examples:

```yaml
documentation_folders:
  - /config/docs
  - /config/automations/docs
  - /config/packages/documentation
```

## Features

- Sidebar item named **Documentation** with icon `mdi:file-document-edit`.
- Folder tree with recursive Markdown discovery.
- Create, rename, move, and delete documents.
- Create subfolders.
- CodeMirror editor with Markdown highlighting.
- Live preview with tables, code blocks, Mermaid diagrams, images, and YAML
  examples.
- Search across configured folders.
- Recently edited documents.
- Favorites/starred documents.
- Image upload support when enabled.
- Export all documentation as a ZIP archive.
- Restore documentation from a ZIP archive.
- Filesystem watchers for changes made by Samba, VS Code, File Editor, Git, or
  SSH.

## Security model

The backend never accepts arbitrary absolute paths from the browser. Every file
operation is resolved against a configured root folder and checked with realpath
validation. Requests are rejected when they attempt:

- `..` path traversal.
- Absolute paths outside configured folders.
- Symbolic link escapes.
- Unsupported file extensions for Markdown documents.
- Uploads larger than `max_upload_size`.

Home Assistant Ingress handles authentication. The add-on does not expose a
public port by default.

## Backups

Home Assistant automatically includes mapped configuration folders in normal
backups. The add-on also supports downloading a ZIP export of all configured
documentation folders and restoring from a ZIP archive.

Database mode stores its SQLite file in `/data/documentation.sqlite`, which is
part of the add-on's persistent data.
