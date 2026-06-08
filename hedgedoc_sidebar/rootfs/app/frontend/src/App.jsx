import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import markdownItAnchor from 'markdown-it-anchor';
import mermaid from 'mermaid';
import {
  Download,
  Eye,
  FilePlus,
  FolderPlus,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Save,
  Search,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import './styles.css';

const ingressBase = window.location.pathname.endsWith('/')
  ? window.location.pathname
  : `${window.location.pathname}/`;

function apiUrl(endpoint) {
  return new URL(`${ingressBase}${endpoint.replace(/^\//, '')}`, window.location.origin).toString();
}

async function request(endpoint, options = {}) {
  const response = await fetch(apiUrl(endpoint), {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }
  return response.json();
}

function flattenTree(nodes, predicate = () => true, list = []) {
  for (const node of nodes || []) {
    if (predicate(node)) {
      list.push(node);
    }
    if (node.children) {
      flattenTree(node.children, predicate, list);
    }
  }
  return list;
}

function findNode(nodes, id) {
  return flattenTree(nodes).find((node) => node.id === id);
}

function findDocumentByPath(nodes, href) {
  const cleanHref = decodeURIComponent(String(href || '').split('#')[0].split('?')[0]).replace(/^\.\//, '');
  if (!cleanHref.endsWith('.md')) {
    return null;
  }
  return flattenTree(nodes, (node) => node.type === 'file').find((node) => {
    return node.path === cleanHref || node.path.endsWith(`/${cleanHref}`) || node.name === cleanHref;
  });
}

function parentFolderId(nodes, documentId) {
  let parent = null;
  function visit(node, currentParent) {
    if (node.id === documentId) {
      parent = currentParent || node;
      return;
    }
    for (const child of node.children || []) {
      visit(child, node.type === 'folder' ? node : currentParent);
    }
  }
  for (const node of nodes || []) {
    visit(node, node.type === 'folder' ? node : null);
  }
  return parent?.id || flattenTree(nodes, (node) => node.type === 'folder')[0]?.id;
}

function Editor({ value, onChange, onSave }) {
  const ref = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onSave]);

  useEffect(() => {
    if (!ref.current || viewRef.current) {
      return undefined;
    }

    const view = new EditorView({
      parent: ref.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div className="editor-shell" ref={ref} />;
}

function TreeNode({ node, selectedId, onOpen, onSelectFolder, selectedFolderId, depth = 0 }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isFolder = node.type === 'folder';
  const active = selectedId === node.id || selectedFolderId === node.id;

  return (
    <div>
      <button
        className={`tree-row ${active ? 'active' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => {
          if (isFolder) {
            setExpanded((value) => !value);
            onSelectFolder(node.id);
          } else {
            onOpen(node.id);
          }
        }}
        title={node.path || node.name}
      >
        <span className="tree-caret">{isFolder ? (expanded ? '▾' : '▸') : '•'}</span>
        <span className="tree-name">{node.name}</span>
        {node.favorite ? <Star className="tiny-icon filled" /> : null}
      </button>
      {isFolder && expanded
        ? node.children?.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              selectedFolderId={selectedFolderId}
              onOpen={onOpen}
              onSelectFolder={onSelectFolder}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  );
}

function Preview({ content, document, tree, onOpenDocument }) {
  const previewRef = useRef(null);

  const html = useMemo(() => {
    const md = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
      breaks: false,
    }).use(markdownItAnchor, { permalink: false });

    const defaultFence = md.renderer.rules.fence?.bind(md.renderer.rules);
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const info = token.info.trim().split(/\s+/)[0].toLowerCase();
      if (info === 'mermaid') {
        return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
      }
      return defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const srcIndex = token.attrIndex('src');
      if (srcIndex >= 0 && document?.id) {
        const src = token.attrs[srcIndex][1];
        if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('#')) {
          token.attrs[srcIndex][1] = apiUrl(
            `api/asset?documentId=${encodeURIComponent(document.id)}&src=${encodeURIComponent(src)}`,
          );
        }
      }
      return self.renderToken(tokens, idx, options);
    };

    return DOMPurify.sanitize(md.render(content || ''), {
      ADD_TAGS: ['iframe'],
      ADD_ATTR: ['target', 'rel'],
    });
  }, [content, document?.id]);

  useEffect(() => {
    const dark = window.document.documentElement?.classList?.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
    });
    mermaid.run({ nodes: previewRef.current?.querySelectorAll('.mermaid') || [] }).catch(() => undefined);
  }, [html]);

  return (
    <article
      className="preview"
      ref={previewRef}
      onClick={(event) => {
        const anchor = event.target.closest?.('a');
        if (!anchor) {
          return;
        }
        const href = anchor.getAttribute('href');
        const target = findDocumentByPath(tree, href);
        if (target) {
          event.preventDefault();
          onOpenDocument(target.id);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function App() {
  const [config, setConfig] = useState(null);
  const [tree, setTree] = useState([]);
  const [metadata, setMetadata] = useState({ favorites: {}, recents: [] });
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [document, setDocument] = useState(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [mode, setMode] = useState('split');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const restoreRef = useRef(null);
  const uploadRef = useRef(null);

  const dirty = content !== savedContent;
  const folders = useMemo(() => flattenTree(tree, (node) => node.type === 'folder'), [tree]);
  const favorites = useMemo(() => flattenTree(tree, (node) => node.type === 'file' && node.favorite), [tree]);

  const loadTree = useCallback(async () => {
    const payload = await request('api/tree');
    setTree(payload.roots || []);
    setSelectedFolderId((current) => current || payload.roots?.[0]?.id || null);
  }, []);

  const loadMetadata = useCallback(async () => {
    setMetadata(await request('api/metadata'));
  }, []);

  const openDocument = useCallback(async (id) => {
    setBusy(true);
    try {
      const payload = await request(`api/document?id=${encodeURIComponent(id)}`);
      setDocument(payload);
      setContent(payload.content || '');
      setSavedContent(payload.content || '');
      setSelectedFolderId(parentFolderId(tree, payload.id));
      await loadMetadata();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [loadMetadata, tree]);

  const saveDocument = useCallback(async () => {
    if (!document) {
      return;
    }
    setBusy(true);
    try {
      const payload = await request('api/document', {
        method: 'PUT',
        body: JSON.stringify({ id: document.id, content }),
      });
      setDocument((current) => ({ ...current, ...payload }));
      setSavedContent(content);
      await Promise.all([loadTree(), loadMetadata()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [content, document, loadMetadata, loadTree]);

  useEffect(() => {
    Promise.all([request('api/config'), request('api/tree'), request('api/metadata')])
      .then(([configPayload, treePayload, metadataPayload]) => {
        setConfig(configPayload);
        setTree(treePayload.roots || []);
        setMetadata(metadataPayload);
        setSelectedFolderId(treePayload.roots?.[0]?.id || null);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const events = new EventSource(apiUrl('api/events'));
    events.onmessage = async (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === 'treeChanged') {
        await loadTree();
      }
      if (payload.type === 'metadataChanged') {
        await loadMetadata();
      }
      if (payload.type === 'documentChanged' && payload.id === document?.id && !dirty) {
        const latest = await request(`api/document?id=${encodeURIComponent(document.id)}`);
        setDocument(latest);
        setContent(latest.content || '');
        setSavedContent(latest.content || '');
      }
    };
    events.onerror = () => undefined;
    return () => events.close();
  }, [dirty, document?.id, loadMetadata, loadTree]);

  useEffect(() => {
    if (config?.watchers) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      loadTree().catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [config?.watchers, loadTree]);

  useEffect(() => {
    const value = query.trim();
    if (!value) {
      setSearchResults([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      request(`api/search?q=${encodeURIComponent(value)}`)
        .then((payload) => setSearchResults(payload.results || []))
        .catch((err) => setError(err.message));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function createDocument() {
    const folderId = selectedFolderId || folders[0]?.id;
    const name = window.prompt('Document name', 'new-document.md');
    if (!folderId || !name) {
      return;
    }
    try {
      const payload = await request('api/document', {
        method: 'POST',
        body: JSON.stringify({ folderId, name, content: `# ${name.replace(/\.md$/i, '')}\n` }),
      });
      await loadTree();
      await openDocument(payload.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createFolder() {
    const parentId = selectedFolderId || folders[0]?.id;
    const name = window.prompt('Folder name', 'documentation');
    if (!parentId || !name) {
      return;
    }
    try {
      const payload = await request('api/folder', {
        method: 'POST',
        body: JSON.stringify({ parentId, name }),
      });
      setSelectedFolderId(payload.id);
      await loadTree();
    } catch (err) {
      setError(err.message);
    }
  }

  async function renameSelected() {
    const target = document || (selectedFolderId ? findNode(tree, selectedFolderId) : null);
    if (!target) {
      return;
    }
    const name = window.prompt('New name', target.name);
    if (!name) {
      return;
    }
    try {
      const payload = await request('api/node', {
        method: 'PATCH',
        body: JSON.stringify({ id: target.id, name }),
      });
      await loadTree();
      if (document?.id === target.id) {
        await openDocument(payload.id);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteSelected() {
    const target = document || (selectedFolderId ? findNode(tree, selectedFolderId) : null);
    if (!target || !window.confirm(`Delete "${target.name}"?`)) {
      return;
    }
    try {
      await request(`api/node?id=${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      if (document?.id === target.id) {
        setDocument(null);
        setContent('');
        setSavedContent('');
      }
      await loadTree();
      await loadMetadata();
    } catch (err) {
      setError(err.message);
    }
  }

  async function moveDocument(event) {
    const targetFolderId = event.target.value;
    event.target.value = '';
    if (!document || !targetFolderId) {
      return;
    }
    try {
      const payload = await request('api/move', {
        method: 'POST',
        body: JSON.stringify({ id: document.id, targetFolderId }),
      });
      await loadTree();
      await openDocument(payload.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleFavorite() {
    if (!document) {
      return;
    }
    try {
      await request('api/favorite', {
        method: 'POST',
        body: JSON.stringify({ id: document.id, favorite: !document.favorite }),
      });
      setDocument((current) => ({ ...current, favorite: !current.favorite }));
      await Promise.all([loadTree(), loadMetadata()]);
    } catch (err) {
      setError(err.message);
    }
  }

  async function restoreDocumentation(file) {
    if (!file) {
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('targetFolderId', selectedFolderId || folders[0]?.id || 'db-root');
    try {
      await request('api/restore', { method: 'POST', body: formData });
      await loadTree();
    } catch (err) {
      setError(err.message);
    }
  }

  async function uploadImage(file) {
    if (!file || !document) {
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('documentId', document.id);
    try {
      const payload = await request('api/upload', { method: 'POST', body: formData });
      setContent((current) => `${current}${current.endsWith('\n') ? '' : '\n'}${payload.markdown}\n`);
    } catch (err) {
      setError(err.message);
    }
  }

  if (!config) {
    return <div className="loading">Loading documentation workspace...</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen((value) => !value)} aria-label="Toggle navigation">
          <Menu />
        </button>
        <div>
          <h1>{config.siteName}</h1>
          <span className="subtitle">
            {config.storageMode === 'filesystem' ? 'Filesystem Markdown source of truth' : 'SQLite database mode'}
          </span>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button" onClick={() => window.open(apiUrl('api/export'), '_blank')}>
            <Download /> Export
          </button>
          <button className="ghost-button" onClick={() => restoreRef.current?.click()}>
            <Upload /> Restore
          </button>
          <input
            ref={restoreRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => restoreDocumentation(event.target.files?.[0])}
          />
        </div>
      </header>

      {error ? (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      ) : null}

      <main className="workspace">
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="sidebar-header">
            <strong>Documents</strong>
            <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}>
              {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </button>
          </div>

          <label className="search-box">
            <Search />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search docs" />
          </label>

          {query ? (
            <section className="panel-section">
              <h2>Search results</h2>
              {searchResults.map((result) => (
                <button key={result.id} className="list-item" onClick={() => openDocument(result.id)}>
                  <strong>{result.name}</strong>
                  <span>{result.path}</span>
                </button>
              ))}
              {!searchResults.length ? <p className="empty">No matches.</p> : null}
            </section>
          ) : null}

          <div className="tree-actions">
            <button onClick={createDocument}>
              <FilePlus /> New document
            </button>
            <button onClick={createFolder}>
              <FolderPlus /> New folder
            </button>
          </div>

          <nav className="tree">
            {tree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                selectedId={document?.id}
                selectedFolderId={selectedFolderId}
                onOpen={openDocument}
                onSelectFolder={setSelectedFolderId}
              />
            ))}
          </nav>

          <section className="panel-section">
            <h2>Favorites</h2>
            {favorites.map((item) => (
              <button key={item.id} className="list-item" onClick={() => openDocument(item.id)}>
                <strong>{item.name}</strong>
                <span>{item.path}</span>
              </button>
            ))}
            {!favorites.length ? <p className="empty">Star documents to pin them here.</p> : null}
          </section>

          <section className="panel-section">
            <h2>Recently edited</h2>
            {metadata.recents?.slice(0, 8).map((item) => (
              <button key={item.id} className="list-item" onClick={() => openDocument(item.id)}>
                <strong>{item.title}</strong>
                <span>{item.path}</span>
              </button>
            ))}
            {!metadata.recents?.length ? <p className="empty">Open or save a document to build history.</p> : null}
          </section>
        </aside>

        <section className="document-area">
          {document ? (
            <>
              <div className="document-toolbar">
                <div className="document-title">
                  <strong>{document.name}</strong>
                  <span>{document.path}</span>
                </div>
                <div className="toolbar-actions">
                  <button className="ghost-button" onClick={toggleFavorite}>
                    <Star className={document.favorite ? 'filled' : ''} /> {document.favorite ? 'Starred' : 'Star'}
                  </button>
                  {config.allowUploads && config.storageMode === 'filesystem' ? (
                    <>
                      <button className="ghost-button" onClick={() => uploadRef.current?.click()}>
                        <Upload /> Image
                      </button>
                      <input
                        ref={uploadRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(event) => uploadImage(event.target.files?.[0])}
                      />
                    </>
                  ) : null}
                  <select className="folder-select" defaultValue="" onChange={moveDocument} title="Move document">
                    <option value="" disabled>
                      Move to...
                    </option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.path || folder.name}
                      </option>
                    ))}
                  </select>
                  <button className="ghost-button" onClick={renameSelected}>Rename</button>
                  <button className="ghost-button danger" onClick={deleteSelected}>
                    <Trash2 /> Delete
                  </button>
                  <button className="primary-button" onClick={saveDocument} disabled={!dirty || busy}>
                    <Save /> {dirty ? 'Save' : 'Saved'}
                  </button>
                </div>
              </div>

              <div className="mode-tabs">
                <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>Edit</button>
                <button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')}>
                  <Eye /> Split preview
                </button>
                <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Preview</button>
              </div>

              <div className={`editor-preview mode-${mode}`}>
                {mode !== 'preview' ? <Editor value={content} onChange={setContent} onSave={saveDocument} /> : null}
                {mode !== 'edit' ? (
                  <Preview content={content} document={document} tree={tree} onOpenDocument={openDocument} />
                ) : null}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <h2>Choose or create a document</h2>
              <p>
                Markdown files are edited directly in the configured Home Assistant folders. Changes made through Samba,
                VS Code, File Editor, Git, or SSH appear here automatically.
              </p>
              <button className="primary-button" onClick={createDocument}>
                <FilePlus /> Create your first document
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
