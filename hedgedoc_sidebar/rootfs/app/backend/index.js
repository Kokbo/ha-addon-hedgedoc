const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const chokidar = require('chokidar');
const express = require('express');
const mime = require('mime-types');
const multer = require('multer');

const PORT = Number(process.env.PORT || 8099);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const OPTIONS_PATH = process.env.OPTIONS_PATH || path.join(DATA_DIR, 'options.json');
const FRONTEND_DIR = path.resolve(__dirname, '../frontend/dist');
const METADATA_PATH = path.join(DATA_DIR, 'metadata.json');
const SQLITE_PATH = path.join(DATA_DIR, 'documentation.sqlite');
const DEFAULT_OPTIONS = {
  site_name: 'Home Documentation',
  storage_mode: 'filesystem',
  documentation_folders: ['/config/docs'],
  allow_uploads: true,
  max_upload_size: 25,
  database_type: 'sqlite',
  enable_file_watchers: true,
};
const DEFAULT_ALLOWED_ROOTS = ['/config', '/share', '/media', '/backup'];
const MARKDOWN_EXTENSION = '.md';
const MAX_SEARCH_RESULTS = 200;

const app = express();
let state;

function log(level, message, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[${level}] ${message}${suffix}`);
}

function encodeId(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeId(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function idFor(rootIndex, relativePath) {
  return `fs:${rootIndex}:${encodeId(relativePath || '')}`;
}

function folderIdFor(relativePath) {
  return `db-folder:${encodeId(relativePath || '')}`;
}

function dbDocId(id) {
  return `db:${id}`;
}

function parseFsId(id) {
  const match = /^fs:(\d+):([A-Za-z0-9_-]*)$/.exec(String(id || ''));
  if (!match) {
    throw httpError(400, 'Invalid filesystem id');
  }
  return {
    rootIndex: Number(match[1]),
    relativePath: decodeId(match[2] || ''),
  };
}

function parseDbFolderId(id) {
  if (!id || id === 'db-root') {
    return '';
  }
  const match = /^db-folder:([A-Za-z0-9_-]*)$/.exec(String(id));
  if (!match) {
    throw httpError(400, 'Invalid database folder id');
  }
  return decodeId(match[1] || '');
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function exists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function realpathIfExists(targetPath) {
  try {
    return await fsp.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafeRelative(relativePath) {
  const value = String(relativePath || '').replace(/\\/g, '/');
  if (value.includes('\0') || path.posix.isAbsolute(value)) {
    throw httpError(400, 'Invalid path');
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw httpError(400, 'Path traversal is not allowed');
  }
  return parts.join('/');
}

function assertSafeSegment(name, label = 'name') {
  const value = String(name || '').trim();
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw httpError(400, `Invalid ${label}`);
  }
  return value;
}

function normalizeMarkdownName(name) {
  const safeName = assertSafeSegment(name, 'document name');
  const extension = path.extname(safeName).toLowerCase();
  if (!extension) {
    return `${safeName}${MARKDOWN_EXTENSION}`;
  }
  if (extension !== MARKDOWN_EXTENSION) {
    throw httpError(400, 'Only .md documents are supported');
  }
  return safeName;
}

function isMarkdownFile(name) {
  return path.extname(name).toLowerCase() === MARKDOWN_EXTENSION;
}

function makeUniqueName(directory, originalName) {
  const parsed = path.parse(originalName.replace(/[^\w.\- ]+/g, '-'));
  const base = parsed.name || 'upload';
  const ext = parsed.ext || '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${base}-${stamp}${ext}`;
}

function readOptions() {
  let options = {};
  try {
    if (fs.existsSync(OPTIONS_PATH)) {
      options = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
    }
  } catch (error) {
    log('warning', 'Unable to read add-on options; using defaults', { error: error.message });
  }

  return {
    ...DEFAULT_OPTIONS,
    ...options,
    site_name: String(options.site_name || DEFAULT_OPTIONS.site_name),
    storage_mode: options.storage_mode === 'database' ? 'database' : 'filesystem',
    documentation_folders: Array.isArray(options.documentation_folders)
      ? options.documentation_folders.filter((folder) => typeof folder === 'string' && folder.trim())
      : DEFAULT_OPTIONS.documentation_folders,
    allow_uploads: options.allow_uploads !== false,
    max_upload_size: Number(options.max_upload_size || DEFAULT_OPTIONS.max_upload_size),
    database_type: 'sqlite',
    enable_file_watchers: options.enable_file_watchers !== false,
  };
}

function allowedRootCandidates() {
  const extras = String(process.env.ALLOWED_DOC_ROOTS || '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_ROOTS, ...extras].map((item) => path.resolve(item));
}

async function normalizeAllowedRoots() {
  const roots = [];
  for (const candidate of allowedRootCandidates()) {
    roots.push(await realpathIfExists(candidate));
  }
  return roots;
}

async function normalizeDocumentationFolders(options) {
  const allowedRoots = await normalizeAllowedRoots();
  const folders = [];

  for (const folder of options.documentation_folders) {
    const resolved = path.resolve(folder);
    if (!path.isAbsolute(folder) || resolved === path.parse(resolved).root) {
      log('warning', 'Ignoring invalid documentation folder', { folder });
      continue;
    }

    if (!allowedRoots.some((root) => isInside(root, resolved))) {
      log('warning', 'Ignoring folder outside allowed Home Assistant mounts', { folder });
      continue;
    }

    await fsp.mkdir(resolved, { recursive: true });
    const real = await fsp.realpath(resolved);

    if (!allowedRoots.some((root) => isInside(root, real))) {
      log('warning', 'Ignoring folder whose real path escapes allowed mounts', { folder, real });
      continue;
    }

    folders.push({
      index: folders.length,
      label: path.basename(real) || real,
      configuredPath: folder,
      realPath: real,
    });
  }

  if (!folders.length && options.storage_mode === 'filesystem') {
    throw new Error('No valid documentation_folders are configured');
  }

  return folders;
}

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_PATH)) {
      const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
      return {
        favorites: metadata.favorites && typeof metadata.favorites === 'object' ? metadata.favorites : {},
        recents: Array.isArray(metadata.recents) ? metadata.recents.slice(0, 50) : [],
      };
    }
  } catch (error) {
    log('warning', 'Unable to read metadata file', { error: error.message });
  }
  return { favorites: {}, recents: [] };
}

async function saveMetadata() {
  const tempPath = `${METADATA_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(state.metadata, null, 2));
  await fsp.rename(tempPath, METADATA_PATH);
  broadcast({ type: 'metadataChanged' });
}

async function addRecent(item) {
  const now = new Date().toISOString();
  const next = {
    id: item.id,
    title: item.title,
    path: item.path || item.title,
    mode: state.options.storage_mode,
    updatedAt: now,
  };
  state.metadata.recents = [next, ...state.metadata.recents.filter((recent) => recent.id !== item.id)].slice(0, 25);
  await saveMetadata();
}

function isFavorite(id) {
  return !!state.metadata.favorites[id];
}

async function setFavorite(id, favorite) {
  if (favorite) {
    state.metadata.favorites[id] = true;
  } else {
    delete state.metadata.favorites[id];
  }

  if (id.startsWith('db:') && state.db) {
    state.db.prepare('UPDATE documents SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, Number(id.slice(3)));
  }

  await saveMetadata();
  broadcast({ type: 'treeChanged' });
}

async function resolveFsPath(id, options = {}) {
  const { rootIndex, relativePath } = parseFsId(id);
  const root = state.folders[rootIndex];
  if (!root) {
    throw httpError(404, 'Unknown documentation folder');
  }

  const safeRelative = assertSafeRelative(relativePath);
  const target = path.resolve(root.realPath, safeRelative);
  if (!isInside(root.realPath, target)) {
    throw httpError(403, 'Path escapes configured folder');
  }

  const targetExists = await exists(target);
  const canonical = targetExists ? await fsp.realpath(target) : await fsp.realpath(path.dirname(target));
  const canonicalTarget = targetExists ? canonical : path.join(canonical, path.basename(target));

  if (!isInside(root.realPath, canonicalTarget)) {
    throw httpError(403, 'Path escapes configured folder');
  }

  if (options.mustExist && !targetExists) {
    throw httpError(404, 'Path not found');
  }

  if (options.markdownOnly && !isMarkdownFile(target)) {
    throw httpError(400, 'Only .md documents are supported');
  }

  return {
    root,
    relativePath: safeRelative,
    absolutePath: target,
  };
}

async function statNode(absolutePath) {
  const stats = await fsp.lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    return null;
  }
  return stats;
}

async function buildFolderNode(root, relativePath = '') {
  const absolutePath = path.join(root.realPath, relativePath);
  const entries = await fsp.readdir(absolutePath, { withFileTypes: true });
  const children = [];

  for (const entry of entries) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childAbsolutePath = path.join(root.realPath, childRelativePath);
    const stats = await statNode(childAbsolutePath);
    if (!stats) {
      continue;
    }

    if (stats.isDirectory()) {
      children.push(await buildFolderNode(root, childRelativePath));
    } else if (stats.isFile() && isMarkdownFile(entry.name)) {
      const id = idFor(root.index, childRelativePath);
      children.push({
        id,
        type: 'file',
        name: entry.name,
        path: childRelativePath,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
        favorite: isFavorite(id),
      });
    }
  }

  children.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    id: idFor(root.index, relativePath),
    type: 'folder',
    name: relativePath ? path.basename(relativePath) : root.label,
    path: relativePath,
    root: root.configuredPath,
    children,
  };
}

async function buildFilesystemTree() {
  const roots = [];
  for (const root of state.folders) {
    roots.push(await buildFolderNode(root));
  }
  return roots;
}

async function readFilesystemDocument(id) {
  const target = await resolveFsPath(id, { mustExist: true, markdownOnly: true });
  const stats = await fsp.stat(target.absolutePath);
  const content = await fsp.readFile(target.absolutePath, 'utf8');
  await addRecent({
    id,
    title: path.basename(target.relativePath),
    path: target.relativePath,
  });
  return {
    id,
    name: path.basename(target.relativePath),
    path: target.relativePath,
    content,
    updatedAt: stats.mtime.toISOString(),
    favorite: isFavorite(id),
  };
}

async function writeFilesystemDocument(id, content) {
  const target = await resolveFsPath(id, { mustExist: true, markdownOnly: true });
  await fsp.writeFile(target.absolutePath, String(content || ''), 'utf8');
  const stats = await fsp.stat(target.absolutePath);
  await addRecent({
    id,
    title: path.basename(target.relativePath),
    path: target.relativePath,
  });
  broadcast({ type: 'documentChanged', id });
  broadcast({ type: 'treeChanged' });
  return {
    id,
    name: path.basename(target.relativePath),
    path: target.relativePath,
    updatedAt: stats.mtime.toISOString(),
  };
}

async function createFilesystemDocument(folderId, name, content = '') {
  const folder = await resolveFsPath(folderId, { mustExist: true });
  const folderStats = await fsp.stat(folder.absolutePath);
  if (!folderStats.isDirectory()) {
    throw httpError(400, 'Target must be a folder');
  }

  const fileName = normalizeMarkdownName(name);
  const relativePath = folder.relativePath ? `${folder.relativePath}/${fileName}` : fileName;
  const id = idFor(folder.root.index, relativePath);
  const target = await resolveFsPath(id, { markdownOnly: true });
  if (await exists(target.absolutePath)) {
    throw httpError(409, 'Document already exists');
  }

  await fsp.writeFile(target.absolutePath, String(content || ''), 'utf8');
  await addRecent({ id, title: fileName, path: relativePath });
  broadcast({ type: 'treeChanged' });
  return readFilesystemDocument(id);
}

async function createFilesystemFolder(parentId, name) {
  const parent = await resolveFsPath(parentId, { mustExist: true });
  const parentStats = await fsp.stat(parent.absolutePath);
  if (!parentStats.isDirectory()) {
    throw httpError(400, 'Target must be a folder');
  }

  const folderName = assertSafeSegment(name, 'folder name');
  const relativePath = parent.relativePath ? `${parent.relativePath}/${folderName}` : folderName;
  const folder = await resolveFsPath(idFor(parent.root.index, relativePath));
  await fsp.mkdir(folder.absolutePath, { recursive: false });
  broadcast({ type: 'treeChanged' });
  return { id: idFor(parent.root.index, relativePath), name: folderName, path: relativePath };
}

async function renameFilesystemNode(id, name) {
  const target = await resolveFsPath(id, { mustExist: true });
  const stats = await fsp.stat(target.absolutePath);
  const newName = stats.isDirectory() ? assertSafeSegment(name, 'folder name') : normalizeMarkdownName(name);
  const newRelativePath = target.relativePath
    ? path.posix.join(path.posix.dirname(target.relativePath), newName)
    : newName;
  const destination = await resolveFsPath(idFor(target.root.index, newRelativePath));
  if (await exists(destination.absolutePath)) {
    throw httpError(409, 'Destination already exists');
  }

  await fsp.rename(target.absolutePath, destination.absolutePath);
  broadcast({ type: 'treeChanged' });
  return { id: idFor(target.root.index, newRelativePath), name: newName, path: newRelativePath };
}

async function moveFilesystemNode(id, targetFolderId) {
  const source = await resolveFsPath(id, { mustExist: true });
  const targetFolder = await resolveFsPath(targetFolderId, { mustExist: true });
  const folderStats = await fsp.stat(targetFolder.absolutePath);
  if (!folderStats.isDirectory()) {
    throw httpError(400, 'Target must be a folder');
  }

  const newRelativePath = targetFolder.relativePath
    ? `${targetFolder.relativePath}/${path.basename(source.relativePath)}`
    : path.basename(source.relativePath);
  const destination = await resolveFsPath(idFor(targetFolder.root.index, newRelativePath));
  if (await exists(destination.absolutePath)) {
    throw httpError(409, 'Destination already exists');
  }

  try {
    await fsp.rename(source.absolutePath, destination.absolutePath);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
    const stats = await fsp.stat(source.absolutePath);
    if (stats.isDirectory()) {
      await fsp.cp(source.absolutePath, destination.absolutePath, { recursive: true, errorOnExist: true });
      await fsp.rm(source.absolutePath, { recursive: true, force: true });
    } else {
      await fsp.copyFile(source.absolutePath, destination.absolutePath);
      await fsp.unlink(source.absolutePath);
    }
  }

  broadcast({ type: 'treeChanged' });
  return {
    id: idFor(targetFolder.root.index, newRelativePath),
    name: path.basename(newRelativePath),
    path: newRelativePath,
  };
}

async function deleteFilesystemNode(id) {
  const target = await resolveFsPath(id, { mustExist: true });
  if (!target.relativePath) {
    throw httpError(400, 'Cannot delete a configured root folder');
  }

  const stats = await fsp.stat(target.absolutePath);
  if (stats.isDirectory()) {
    await fsp.rm(target.absolutePath, { recursive: true, force: false });
  } else {
    await fsp.unlink(target.absolutePath);
  }

  delete state.metadata.favorites[id];
  state.metadata.recents = state.metadata.recents.filter((recent) => recent.id !== id);
  await saveMetadata();
  broadcast({ type: 'treeChanged' });
  return { ok: true };
}

async function walkFiles(root, relativePath = '', files = []) {
  const absolutePath = path.join(root.realPath, relativePath);
  const entries = await fsp.readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childAbsolutePath = path.join(root.realPath, childRelativePath);
    const stats = await statNode(childAbsolutePath);
    if (!stats) {
      continue;
    }
    if (stats.isDirectory()) {
      await walkFiles(root, childRelativePath, files);
    } else if (stats.isFile()) {
      files.push({ root, relativePath: childRelativePath, absolutePath: childAbsolutePath, stats });
    }
  }
  return files;
}

async function searchFilesystem(query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const results = [];
  for (const root of state.folders) {
    const files = await walkFiles(root);
    for (const file of files) {
      if (!isMarkdownFile(file.relativePath)) {
        continue;
      }
      const content = await fsp.readFile(file.absolutePath, 'utf8');
      const haystacks = [file.relativePath.toLowerCase(), content.toLowerCase()];
      if (!haystacks.some((haystack) => haystack.includes(normalizedQuery))) {
        continue;
      }
      const index = content.toLowerCase().indexOf(normalizedQuery);
      const excerpt = index >= 0
        ? content.slice(Math.max(0, index - 80), Math.min(content.length, index + normalizedQuery.length + 120))
        : '';
      const id = idFor(root.index, file.relativePath);
      results.push({
        id,
        name: path.basename(file.relativePath),
        path: file.relativePath,
        root: root.configuredPath,
        excerpt,
      });
      if (results.length >= MAX_SEARCH_RESULTS) {
        return results;
      }
    }
  }
  return results;
}

function createDatabase() {
  const db = new Database(SQLITE_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS folders (
      path TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function normalizeDbPath(value, options = {}) {
  const safe = assertSafeRelative(value || '');
  if (options.document) {
    const name = path.posix.basename(safe);
    if (!isMarkdownFile(name)) {
      throw httpError(400, 'Only .md documents are supported');
    }
  }
  return safe;
}

function buildDatabaseTree() {
  const root = {
    id: 'db-root',
    type: 'folder',
    name: 'Database',
    path: '',
    root: 'SQLite',
    children: [],
  };
  const folders = new Map([['', root]]);

  const ensureFolder = (folderPath) => {
    const safePath = normalizeDbPath(folderPath || '');
    if (folders.has(safePath)) {
      return folders.get(safePath);
    }
    const parentPath = path.posix.dirname(safePath);
    const parent = ensureFolder(parentPath === '.' ? '' : parentPath);
    const node = {
      id: folderIdFor(safePath),
      type: 'folder',
      name: path.posix.basename(safePath),
      path: safePath,
      root: 'SQLite',
      children: [],
    };
    parent.children.push(node);
    folders.set(safePath, node);
    return node;
  };

  for (const row of state.db.prepare('SELECT path FROM folders ORDER BY path').all()) {
    ensureFolder(row.path);
  }

  for (const doc of state.db.prepare('SELECT id, path, updated_at, favorite, length(content) AS size FROM documents ORDER BY path').all()) {
    const parentPath = path.posix.dirname(doc.path);
    const parent = ensureFolder(parentPath === '.' ? '' : parentPath);
    parent.children.push({
      id: dbDocId(doc.id),
      type: 'file',
      name: path.posix.basename(doc.path),
      path: doc.path,
      size: doc.size,
      updatedAt: doc.updated_at,
      favorite: !!doc.favorite || isFavorite(dbDocId(doc.id)),
    });
  }

  const sortNode = (node) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
      if (child.type === 'folder') {
        sortNode(child);
      }
    }
  };
  sortNode(root);
  return [root];
}

function readDatabaseDocument(id) {
  const documentId = Number(String(id || '').replace(/^db:/, ''));
  const row = state.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!row) {
    throw httpError(404, 'Document not found');
  }
  addRecent({ id: dbDocId(row.id), title: path.posix.basename(row.path), path: row.path }).catch((error) => {
    log('warning', 'Unable to update recents', { error: error.message });
  });
  return {
    id: dbDocId(row.id),
    name: path.posix.basename(row.path),
    path: row.path,
    content: row.content,
    updatedAt: row.updated_at,
    favorite: !!row.favorite || isFavorite(dbDocId(row.id)),
  };
}

function writeDatabaseDocument(id, content) {
  const document = readDatabaseDocument(id);
  const now = new Date().toISOString();
  state.db.prepare('UPDATE documents SET content = ?, updated_at = ? WHERE id = ?').run(String(content || ''), now, Number(id.slice(3)));
  broadcast({ type: 'documentChanged', id });
  broadcast({ type: 'treeChanged' });
  return { ...document, content: String(content || ''), updatedAt: now };
}

function createDatabaseDocument(folderId, name, content = '') {
  const folderPath = parseDbFolderId(folderId);
  const fileName = normalizeMarkdownName(name);
  const docPath = normalizeDbPath(folderPath ? `${folderPath}/${fileName}` : fileName, { document: true });
  const now = new Date().toISOString();
  const result = state.db
    .prepare('INSERT INTO documents(path, content, favorite, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
    .run(docPath, String(content || ''), now, now);
  broadcast({ type: 'treeChanged' });
  return readDatabaseDocument(dbDocId(result.lastInsertRowid));
}

function createDatabaseFolder(parentId, name) {
  const parentPath = parseDbFolderId(parentId);
  const folderName = assertSafeSegment(name, 'folder name');
  const folderPath = normalizeDbPath(parentPath ? `${parentPath}/${folderName}` : folderName);
  state.db.prepare('INSERT INTO folders(path, created_at) VALUES (?, ?)').run(folderPath, new Date().toISOString());
  broadcast({ type: 'treeChanged' });
  return { id: folderIdFor(folderPath), name: folderName, path: folderPath };
}

function renameDatabaseNode(id, name) {
  const now = new Date().toISOString();
  if (String(id).startsWith('db:')) {
    const doc = readDatabaseDocument(id);
    const newName = normalizeMarkdownName(name);
    const parent = path.posix.dirname(doc.path);
    const newPath = normalizeDbPath(parent === '.' ? newName : `${parent}/${newName}`, { document: true });
    state.db.prepare('UPDATE documents SET path = ?, updated_at = ? WHERE id = ?').run(newPath, now, Number(id.slice(3)));
    broadcast({ type: 'treeChanged' });
    return { id, name: newName, path: newPath };
  }

  const folderPath = parseDbFolderId(id);
  if (!folderPath) {
    throw httpError(400, 'Cannot rename the database root');
  }
  const newName = assertSafeSegment(name, 'folder name');
  const parent = path.posix.dirname(folderPath);
  const newPath = normalizeDbPath(parent === '.' ? newName : `${parent}/${newName}`);
  const docs = state.db.prepare('SELECT id, path FROM documents WHERE path = ? OR path LIKE ?').all(folderPath, `${folderPath}/%`);
  const folders = state.db.prepare('SELECT path FROM folders WHERE path = ? OR path LIKE ?').all(folderPath, `${folderPath}/%`);
  const transaction = state.db.transaction(() => {
    for (const row of docs) {
      state.db.prepare('UPDATE documents SET path = ?, updated_at = ? WHERE id = ?').run(row.path.replace(folderPath, newPath), now, row.id);
    }
    for (const row of folders) {
      state.db.prepare('DELETE FROM folders WHERE path = ?').run(row.path);
      state.db.prepare('INSERT INTO folders(path, created_at) VALUES (?, ?)').run(row.path.replace(folderPath, newPath), now);
    }
  });
  transaction();
  broadcast({ type: 'treeChanged' });
  return { id: folderIdFor(newPath), name: newName, path: newPath };
}

function moveDatabaseNode(id, targetFolderId) {
  const targetFolder = parseDbFolderId(targetFolderId);
  const now = new Date().toISOString();
  if (String(id).startsWith('db:')) {
    const doc = readDatabaseDocument(id);
    const newPath = normalizeDbPath(targetFolder ? `${targetFolder}/${path.posix.basename(doc.path)}` : path.posix.basename(doc.path), {
      document: true,
    });
    state.db.prepare('UPDATE documents SET path = ?, updated_at = ? WHERE id = ?').run(newPath, now, Number(id.slice(3)));
    broadcast({ type: 'treeChanged' });
    return { id, name: path.posix.basename(newPath), path: newPath };
  }
  throw httpError(400, 'Database folder moves are not supported; rename the folder path instead');
}

function deleteDatabaseNode(id) {
  if (String(id).startsWith('db:')) {
    state.db.prepare('DELETE FROM documents WHERE id = ?').run(Number(id.slice(3)));
    delete state.metadata.favorites[id];
  } else {
    const folderPath = parseDbFolderId(id);
    if (!folderPath) {
      throw httpError(400, 'Cannot delete the database root');
    }
    state.db.prepare('DELETE FROM documents WHERE path = ? OR path LIKE ?').run(folderPath, `${folderPath}/%`);
    state.db.prepare('DELETE FROM folders WHERE path = ? OR path LIKE ?').run(folderPath, `${folderPath}/%`);
  }
  saveMetadata().catch((error) => log('warning', 'Unable to save metadata', { error: error.message }));
  broadcast({ type: 'treeChanged' });
  return { ok: true };
}

function searchDatabase(query) {
  const value = `%${String(query || '').trim()}%`;
  if (value === '%%') {
    return [];
  }
  return state.db
    .prepare('SELECT id, path, substr(content, 1, 240) AS excerpt FROM documents WHERE path LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT ?')
    .all(value, value, MAX_SEARCH_RESULTS)
    .map((row) => ({
      id: dbDocId(row.id),
      name: path.posix.basename(row.path),
      path: row.path,
      root: 'SQLite',
      excerpt: row.excerpt,
    }));
}

async function createExportZip() {
  const zip = new AdmZip();

  if (state.options.storage_mode === 'database') {
    for (const row of state.db.prepare('SELECT path, content FROM documents ORDER BY path').all()) {
      zip.addFile(`database/${row.path}`, Buffer.from(row.content, 'utf8'));
    }
    return zip.toBuffer();
  }

  for (const root of state.folders) {
    const prefix = `${root.index + 1}-${path.basename(root.realPath) || 'root'}`;
    const files = await walkFiles(root);
    for (const file of files) {
      const data = await fsp.readFile(file.absolutePath);
      zip.addFile(`${prefix}/${file.relativePath}`, data);
    }
  }
  return zip.toBuffer();
}

async function restoreZip(filePath, targetFolderId) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  if (state.options.storage_mode === 'database') {
    const now = new Date().toISOString();
    const insert = state.db.prepare(
      'INSERT INTO documents(path, content, favorite, created_at, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at',
    );
    const transaction = state.db.transaction(() => {
      for (const entry of entries) {
        if (entry.isDirectory) {
          continue;
        }
        const safePath = normalizeDbPath(entry.entryName.replace(/^database\//, ''), { document: true });
        insert.run(safePath, entry.getData().toString('utf8'), now, now);
      }
    });
    transaction();
    broadcast({ type: 'treeChanged' });
    return { restored: entries.length };
  }

  const target = await resolveFsPath(targetFolderId, { mustExist: true });
  const targetStats = await fsp.stat(target.absolutePath);
  if (!targetStats.isDirectory()) {
    throw httpError(400, 'Restore target must be a folder');
  }

  let restored = 0;
  for (const entry of entries) {
    const entryName = assertSafeRelative(entry.entryName);
    if (!entryName) {
      continue;
    }
    const destination = path.resolve(target.absolutePath, entryName);
    if (!isInside(target.absolutePath, destination)) {
      throw httpError(403, 'Zip entry escapes target folder');
    }

    if (entry.isDirectory) {
      await fsp.mkdir(destination, { recursive: true });
      continue;
    }

    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, entry.getData());
    restored += 1;
  }

  broadcast({ type: 'treeChanged' });
  return { restored };
}

async function uploadAsset(file, targetFolderId, documentId) {
  if (!state.options.allow_uploads) {
    throw httpError(403, 'Uploads are disabled');
  }
  if (!file) {
    throw httpError(400, 'No file uploaded');
  }
  const mimeType = file.mimetype || mime.lookup(file.originalname) || '';
  if (!String(mimeType).startsWith('image/')) {
    throw httpError(400, 'Only image uploads are supported');
  }

  let folderId = targetFolderId;
  if (!folderId && documentId && state.options.storage_mode === 'filesystem') {
    const document = await resolveFsPath(documentId, { mustExist: true, markdownOnly: true });
    folderId = idFor(document.root.index, path.posix.dirname(document.relativePath) === '.' ? '' : path.posix.dirname(document.relativePath));
  }
  if (!folderId) {
    throw httpError(400, 'Upload target folder is required');
  }

  const target = await resolveFsPath(folderId, { mustExist: true });
  const assetDir = path.join(target.absolutePath, 'assets');
  await fsp.mkdir(assetDir, { recursive: true });
  const fileName = makeUniqueName(assetDir, file.originalname || 'image');
  const destination = path.join(assetDir, fileName);
  await fsp.rename(file.path, destination);

  const relativeUrl = target.relativePath ? `${target.relativePath}/assets/${fileName}` : `assets/${fileName}`;
  broadcast({ type: 'treeChanged' });
  return {
    name: fileName,
    path: relativeUrl,
    markdown: `![${path.parse(fileName).name}](./${path.posix.relative(target.relativePath || '.', relativeUrl)})`,
  };
}

async function resolveAsset(documentId, source) {
  if (state.options.storage_mode !== 'filesystem') {
    throw httpError(404, 'Assets are only available in filesystem mode');
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(String(source || ''))) {
    throw httpError(400, 'Remote asset URLs are not proxied');
  }

  const document = await resolveFsPath(documentId, { mustExist: true, markdownOnly: true });
  const documentFolder = path.posix.dirname(document.relativePath) === '.'
    ? ''
    : path.posix.dirname(document.relativePath);
  const relativeSource = assertSafeRelative(path.posix.normalize(path.posix.join(documentFolder, String(source || ''))));
  const asset = await resolveFsPath(idFor(document.root.index, relativeSource), { mustExist: true });
  const stats = await fsp.stat(asset.absolutePath);
  if (!stats.isFile()) {
    throw httpError(404, 'Asset not found');
  }
  return asset;
}

function clients() {
  if (!state.sseClients) {
    state.sseClients = new Set();
  }
  return state.sseClients;
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`;
  for (const client of clients()) {
    client.write(payload);
  }
}

function setupWatchers() {
  if (!state.options.enable_file_watchers || state.options.storage_mode !== 'filesystem') {
    return;
  }

  state.watchers = state.folders.map((folder) => {
    const watcher = chokidar.watch(folder.realPath, {
      awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 100 },
      ignoreInitial: true,
      ignored: (candidatePath) => path.basename(candidatePath) === '.git',
      persistent: true,
    });
    watcher.on('all', (event, changedPath) => {
      log('debug', 'Filesystem change detected', { event, path: changedPath });
      broadcast({ type: 'treeChanged', event });
      if (isMarkdownFile(changedPath)) {
        const root = state.folders.find((item) => isInside(item.realPath, path.resolve(changedPath)));
        if (root) {
          const relativePath = path.relative(root.realPath, path.resolve(changedPath)).replace(/\\/g, '/');
          broadcast({ type: 'documentChanged', id: idFor(root.index, relativePath) });
        }
      }
    });
    watcher.on('error', (error) => log('warning', 'Filesystem watcher error', { folder: folder.realPath, error: error.message }));
    return watcher;
  });
}

function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function treeForMode() {
  return state.options.storage_mode === 'database' ? buildDatabaseTree() : buildFilesystemTree();
}

function uploadMiddleware() {
  const upload = multer({
    dest: path.join(DATA_DIR, 'uploads'),
    limits: {
      fileSize: Math.max(1, state.options.max_upload_size) * 1024 * 1024,
    },
  });
  return upload.single('file');
}

async function init() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(path.join(DATA_DIR, 'uploads'), { recursive: true });

  const options = readOptions();
  const folders = await normalizeDocumentationFolders(options);
  state = {
    options,
    folders,
    metadata: loadMetadata(),
    db: createDatabase(),
    sseClients: new Set(),
    watchers: [],
  };

  setupWatchers();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/config', (_request, response) => {
    response.json({
      siteName: state.options.site_name,
      storageMode: state.options.storage_mode,
      allowUploads: state.options.allow_uploads,
      maxUploadSize: state.options.max_upload_size,
      watchers: state.options.enable_file_watchers,
      folders: state.folders.map((folder) => ({
        id: idFor(folder.index, ''),
        label: folder.label,
        configuredPath: folder.configuredPath,
      })),
    });
  });

  app.get('/api/events', (request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`);
    clients().add(response);
    request.on('close', () => clients().delete(response));
  });

  app.get('/api/tree', asyncHandler(async (_request, response) => {
    response.json({ roots: await treeForMode() });
  }));

  app.get('/api/metadata', (_request, response) => {
    response.json(state.metadata);
  });

  app.post('/api/favorite', asyncHandler(async (request, response) => {
    await setFavorite(String(request.body.id || ''), !!request.body.favorite);
    response.json({ ok: true });
  }));

  app.get('/api/document', asyncHandler(async (request, response) => {
    const id = String(request.query.id || '');
    const document = state.options.storage_mode === 'database'
      ? readDatabaseDocument(id)
      : await readFilesystemDocument(id);
    response.json(document);
  }));

  app.put('/api/document', asyncHandler(async (request, response) => {
    const id = String(request.body.id || '');
    const document = state.options.storage_mode === 'database'
      ? writeDatabaseDocument(id, request.body.content)
      : await writeFilesystemDocument(id, request.body.content);
    response.json(document);
  }));

  app.post('/api/document', asyncHandler(async (request, response) => {
    const document = state.options.storage_mode === 'database'
      ? createDatabaseDocument(request.body.folderId, request.body.name, request.body.content)
      : await createFilesystemDocument(request.body.folderId, request.body.name, request.body.content);
    response.status(201).json(document);
  }));

  app.patch('/api/node', asyncHandler(async (request, response) => {
    const result = state.options.storage_mode === 'database'
      ? renameDatabaseNode(request.body.id, request.body.name)
      : await renameFilesystemNode(request.body.id, request.body.name);
    response.json(result);
  }));

  app.post('/api/folder', asyncHandler(async (request, response) => {
    const result = state.options.storage_mode === 'database'
      ? createDatabaseFolder(request.body.parentId, request.body.name)
      : await createFilesystemFolder(request.body.parentId, request.body.name);
    response.status(201).json(result);
  }));

  app.post('/api/move', asyncHandler(async (request, response) => {
    const result = state.options.storage_mode === 'database'
      ? moveDatabaseNode(request.body.id, request.body.targetFolderId)
      : await moveFilesystemNode(request.body.id, request.body.targetFolderId);
    response.json(result);
  }));

  app.delete('/api/node', asyncHandler(async (request, response) => {
    const id = String(request.query.id || '');
    const result = state.options.storage_mode === 'database'
      ? deleteDatabaseNode(id)
      : await deleteFilesystemNode(id);
    response.json(result);
  }));

  app.get('/api/search', asyncHandler(async (request, response) => {
    const results = state.options.storage_mode === 'database'
      ? searchDatabase(request.query.q)
      : await searchFilesystem(request.query.q);
    response.json({ results });
  }));

  app.get('/api/asset', asyncHandler(async (request, response) => {
    const asset = await resolveAsset(String(request.query.documentId || ''), String(request.query.src || ''));
    response.setHeader('Content-Type', mime.lookup(asset.absolutePath) || 'application/octet-stream');
    response.sendFile(asset.absolutePath);
  }));

  app.get('/api/export', asyncHandler(async (_request, response) => {
    const buffer = await createExportZip();
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="home-documentation-${Date.now()}.zip"`);
    response.send(buffer);
  }));

  app.post('/api/restore', uploadMiddleware(), asyncHandler(async (request, response) => {
    try {
      const result = await restoreZip(request.file.path, request.body.targetFolderId || request.body.folderId || 'db-root');
      response.json(result);
    } finally {
      if (request.file?.path) {
        fsp.unlink(request.file.path).catch(() => undefined);
      }
    }
  }));

  app.post('/api/upload', uploadMiddleware(), asyncHandler(async (request, response) => {
    try {
      const result = await uploadAsset(request.file, request.body.targetFolderId, request.body.documentId);
      response.status(201).json(result);
    } catch (error) {
      if (request.file?.path) {
        fsp.unlink(request.file.path).catch(() => undefined);
      }
      throw error;
    }
  }));

  app.use(express.static(FRONTEND_DIR, { index: false }));
  app.get(/^(?!\/api\/).*/, (_request, response) => {
    response.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });

  app.use((error, _request, response, _next) => {
    const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) {
      log('error', 'Unhandled request error', { error: error.message, stack: error.stack });
    }
    response.status(status).json({ error: error.message || 'Unexpected error' });
  });

  app.listen(PORT, () => {
    log('info', `HedgeDoc Sidebar listening on ${PORT}`, {
      mode: state.options.storage_mode,
      folders: state.folders.map((folder) => folder.configuredPath),
    });
  });
}

process.on('SIGTERM', async () => {
  for (const watcher of state?.watchers || []) {
    await watcher.close();
  }
  state?.db?.close();
  process.exit(0);
});

init().catch((error) => {
  log('fatal', 'Failed to start HedgeDoc Sidebar', { error: error.message, stack: error.stack });
  process.exit(1);
});
