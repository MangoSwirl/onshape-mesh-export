// Browser side. Exports the tessellation the Onshape web client received for the open Part Studio or Assembly.
//
// The client stores every display-data message it receives in IndexedDB (CacheDbV*: `entries`, `data` and per-part
// `tessellations`) in Onshape's binary serialization. This script reads those records and decodes them with the
// client's own reader (found in its webpack bundle), so the triangles are exactly the ones the viewer draws.
// The only network call is an optional REST read of the assembly definition, for instance names.

const UNITS = { mm: 1000, m: 1, in: 1 / 0.0254 }
const DISPLAY_TYPES = ['DISPLAY_DATA', 'PARTBUFFER_DISPLAY_DATA']

// ---- Onshape client internals ----

let readerFn = null
/** Onshape's own binary message reader, wrapped to return plain objects. */
function clientReader() {
  if (readerFn) return readerFn
  const chunks = window.webpackChunkNewton
  if (!chunks || typeof chunks.push !== 'function') throw new Error('This page is not the Onshape editor.')
  let req = null
  chunks.push([[Symbol('onshape-mesh-export')], {}, (r) => { req = r }])
  if (!req || !req.m) throw new Error('Could not reach the Onshape client’s modules.')
  for (const id of Object.keys(req.m)) {
    const src = Function.prototype.toString.call(req.m[id])
    if (!src.includes('extractStringTable') || !src.includes('readMessage')) continue
    for (const v of Object.values(req(id))) {
      if (typeof v === 'function' && v.prototype && typeof v.prototype.readMessage === 'function' && typeof v.prototype.extractStringTable === 'function') {
        readerFn = (bytes) => plainMessage(new v(bytes).readMessage())
        return readerFn
      }
    }
  }
  throw new Error('Could not find Onshape’s message reader. The Onshape client may have changed.')
}

// ---- The client's display-data cache ----

async function openCache() {
  const dbs = indexedDB.databases ? await indexedDB.databases() : []
  const names = dbs.map((d) => d.name).filter((n) => /^CacheDbV\d+$/.test(n)).sort((a, b) => +b.slice(8) - +a.slice(8))
  // Only open a database the client already made: opening a missing one would create it.
  if (!names.length) throw new Error('Onshape’s graphics cache is empty. Let the model finish loading, then try again.')
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(names[0])
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.onblocked = () => reject(new Error('Onshape’s graphics cache is busy. Try again.'))
  })
}

function idb(db, store, method, arg) {
  return new Promise((resolve, reject) => {
    const q = db.transaction(store, 'readonly').objectStore(store)[method](arg)
    q.onsuccess = () => resolve(q.result)
    q.onerror = () => reject(q.error)
  })
}
const prefix = (key) => IDBKeyRange.bound(key, [...key, []])

/** The record the viewer used most recently for an element (its current microversion and configuration). */
async function latestEntry(db, elementId) {
  const rows = (await idb(db, 'entries', 'getAll', prefix([elementId]))).filter((e) => DISPLAY_TYPES.includes(e.dataType))
  rows.sort((a, b) => (b.lastUsed?.getTime?.() || 0) - (a.lastUsed?.getTime?.() || 0))
  return rows[0] || null
}

/** Display-data records for one Part Studio microversion and configuration: the element's own, then per-part. */
async function studioRecords(db, read, s) {
  for (const type of DISPLAY_TYPES) {
    const key = [s.elementId, s.microversionId, s.configuration, type]
    const data = await idb(db, 'data', 'get', key)
    const tess = await idb(db, 'tessellations', 'getAll', prefix(key))
    if (!data && !tess.length) continue
    return { main: data ? read(data.messageData) : null, parts: tess.map((t) => read(t.tessellationData)) }
  }
  return null
}

// ---- Items: one per part (Part Studio) or per part occurrence (Assembly) ----

async function assemblyNames(loc) {
  try {
    const res = await fetch(`${loc.origin}/api/v6/assemblies/d/${loc.did}/${loc.wvm}/${loc.wvmid}/e/${loc.eid}`, { credentials: 'include', headers: { Accept: 'application/json' } })
    if (!res.ok) return new Map()
    return new Map(assemblyPartOccurrences(await res.json()).map((o) => [o.key, o.names]))
  } catch {
    return new Map()
  }
}

async function loadContext() {
  const loc = parseOnshapeUrl(location.href)
  if (!loc) throw new Error('Open a Part Studio or Assembly tab first.')
  const read = clientReader()
  const db = await openCache()
  const entry = await latestEntry(db, loc.eid)
  if (!entry) throw new Error('Onshape hasn’t cached this tab’s graphics yet. Let it finish loading, then try again.')
  const root = read((await idb(db, 'data', 'get', [entry.elementId, entry.microversionId, entry.configurationId, entry.dataType])).messageData)
  const name = (document.title.split(' | ').pop() || 'export').trim()
  const studios = new Map()
  const studio = (s) => {
    const k = sourceKey(s)
    if (!studios.has(k)) studios.set(k, studioRecords(db, read, s))
    return studios.get(k)
  }

  if (root.$type === 'assemblydisplay.GBTRootAssemblyDisplayData') {
    const names = await assemblyNames(loc)
    const items = assemblyItems(root)
    for (const it of items) {
      const rec = await studio(it.source)
      const part = rec?.main && studioParts(rec.main).find((p) => p.id === it.partId)
      const fromRest = names.get(it.path.join('/'))
      it.label = fromRest ? fromRest.join(' › ') : `${part?.name || it.partId} (${it.path.length > 1 ? 'nested ' : ''}instance ${it.path[it.path.length - 1].slice(0, 6)})`
      it.fileBase = fromRest ? fromRest.join(' - ') : it.label
    }
    return { type: 'ASSEMBLY', name, items, studio }
  }
  if (root.$type === 'display.GBTPartStudioDisplayData') {
    const source = { elementId: entry.elementId, microversionId: entry.microversionId, configuration: entry.configurationId }
    const items = studioParts(root).map((p) => ({ key: p.id, partId: p.id, label: p.name, fileBase: p.name, hidden: p.hidden, source }))
    return { type: 'PARTSTUDIO', name, items, studio }
  }
  throw new Error(`This tab’s graphics are a ${root.$type}, not a Part Studio or Assembly.`)
}

// ---- Export ----

async function itemGeometry(ctx, item) {
  const rec = await ctx.studio(item.source)
  const messages = rec ? [rec.main, ...rec.parts].filter(Boolean) : []
  const tris = messages.length ? partTriangles(item.partId, messages) : null
  if (!tris) throw new Error('the viewer hasn’t loaded this part’s triangles (is it hidden or still loading?)')
  return { tris, messages }
}

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function writeMesh(base, bodies, opts) {
  const scale = UNITS[opts.units]
  if (opts.format === 'obj') download(`${safeFileName(base)}.obj`, toOBJ(bodies, scale), 'model/obj')
  else download(`${safeFileName(base)}.stl`, toBinarySTL(bodies, scale, `${base} (${opts.units})`), 'model/stl')
}

/** Fetches and saves the chosen items, one file each or all in one. Returns the failures. */
async function exportItems(ctx, items, opts, progress) {
  const placed = ctx.type === 'ASSEMBLY' && opts.placed
  const failed = []
  const collected = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    progress(i + 1, items.length, item.label)
    try {
      const { tris, messages } = await itemGeometry(ctx, item)
      const useT = placed && item.transform
      if (opts.format === 'json') {
        const rec = { name: item.label, partId: item.partId, units: 'm', ...(useT ? { transform: item.transform } : {}), source: item.source, faces: partFaces(item.partId, messages) }
        if (opts.combine) collected.push(rec)
        else download(`${safeFileName(item.fileBase)}.tessellation.json`, JSON.stringify(rec), 'application/json')
        continue
      }
      let bodies = [{ name: item.label, positions: tris }]
      if (useT) bodies = transformBodies(bodies, item.transform, item.label)
      if (opts.combine) collected.push(...bodies)
      else writeMesh(item.fileBase, bodies, opts)
    } catch (e) {
      failed.push(`${item.label}: ${e.message}`)
      console.error('[onshape-mesh-export]', item.label, e)
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  if (opts.combine && collected.length) {
    if (opts.format === 'json') download(`${safeFileName(ctx.name)}.tessellation.json`, JSON.stringify(collected), 'application/json')
    else writeMesh(ctx.name, collected, opts)
  }
  return failed
}

// ---- UI ----

const CSS = `
#ome-btn{position:fixed;z-index:2147483646;left:12px;bottom:12px;padding:6px 10px;border:0;border-radius:6px;
  font:600 12px system-ui,sans-serif;color:#fff;background:#2b5fb4;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer}
#ome-panel{position:fixed;z-index:2147483647;left:12px;bottom:48px;width:380px;max-height:75vh;display:flex;flex-direction:column;
  font:13px/1.4 system-ui,sans-serif;color:#1d2733;background:#fff;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.3)}
#ome-panel header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;font-weight:600;border-bottom:1px solid #e3e7ec}
#ome-panel header .title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ome-panel .opts{display:flex;flex-wrap:wrap;gap:6px 10px;padding:8px 12px;border-bottom:1px solid #e3e7ec}
#ome-panel .opts .row{display:flex;gap:6px;width:100%}
#ome-panel select{font:inherit;flex:1;min-width:0}
#ome-panel label{display:flex;align-items:center;gap:4px;font-size:12px}
#ome-panel ul{list-style:none;margin:0;padding:4px 0;overflow:auto}
#ome-panel li{display:flex;align-items:center;gap:8px;padding:3px 12px}
#ome-panel li span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ome-panel li.hidden span{opacity:.55}
#ome-panel footer{display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid #e3e7ec}
#ome-panel footer .msg{flex:1;font-size:12px;color:#556}
#ome-panel button{font:inherit;cursor:pointer}
#ome-panel .err{color:#b3261e}
`

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn)
    else if (k in e) e[k] = v
    else e.setAttribute(k, v)
  }
  e.append(...kids)
  return e
}

function select(name, choices, value) {
  return el('select', { name, title: name }, ...Object.entries(choices).map(([v, label]) => el('option', { value: v, textContent: label, selected: v === value })))
}

const PREFS_KEY = 'onshape-mesh-export:prefs'
const DEFAULT_PREFS = { format: 'stl', units: 'mm', combine: false, placed: true }
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } } catch { return { ...DEFAULT_PREFS } }
}
function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch {} }

async function openPanel() {
  document.getElementById('ome-panel')?.remove()
  const msg = el('div', { className: 'msg' })
  const list = el('ul')
  const prefs = loadPrefs()
  const fmt = select('Format', { stl: 'STL (binary)', obj: 'OBJ', json: 'Raw JSON' }, prefs.format)
  const units = select('Units', { mm: 'mm', m: 'm', in: 'in' }, prefs.units)
  const combine = el('input', { type: 'checkbox', checked: prefs.combine })
  const placed = el('input', { type: 'checkbox', checked: prefs.placed })
  const placedLabel = el('label', { title: 'Off: each part in its own Part Studio coordinates' }, placed, 'Keep assembly positions')
  placedLabel.style.display = 'none'
  const all = el('input', { type: 'checkbox', title: 'Select all' })
  const title = el('span', { className: 'title', textContent: 'Export part meshes' })
  const exportBtn = el('button', { textContent: 'Download selected', disabled: true })
  const panel = el('div', { id: 'ome-panel' },
    el('header', {}, title, el('button', { textContent: '✕', title: 'Close', on: { click: () => panel.remove() } })),
    el('div', { className: 'opts' },
      el('div', { className: 'row' }, fmt, units),
      el('label', {}, combine, 'One file'), placedLabel, el('label', {}, all, 'All')),
    list,
    el('footer', {}, msg, exportBtn),
  )
  document.body.append(panel)
  const say = (text, error = false) => { msg.textContent = text; msg.className = error ? 'msg err' : 'msg' }
  const opts = () => {
    const o = { format: fmt.value, units: units.value, combine: combine.checked, placed: placed.checked }
    savePrefs(o)
    return o
  }

  say('Reading the viewer’s geometry…')
  let ctx
  try {
    ctx = await loadContext()
  } catch (e) {
    console.error('[onshape-mesh-export]', e)
    return say(e.message, true)
  }
  title.textContent = ctx.name
  title.title = ctx.name
  if (ctx.type === 'ASSEMBLY') placedLabel.style.display = ''
  const items = ctx.items
  if (!items.length) return say('No parts here.')

  const run = async (chosen) => {
    exportBtn.disabled = true
    const o = opts()
    const failed = await exportItems(ctx, chosen, o, (n, total, label) => say(`${n}/${total}: ${label}`))
    sync()
    if (failed.length) say(`${failed.length} of ${chosen.length} failed. ${failed[0]}`, true)
    else say(`Downloaded ${chosen.length} part${chosen.length === 1 ? '' : 's'}${o.combine && chosen.length > 1 ? ' in one file' : ''}.`)
  }

  const boxes = items.map((it) => {
    const box = el('input', { type: 'checkbox', checked: !it.hidden })
    list.append(el('li', { className: it.hidden ? 'hidden' : '', title: it.label + (it.hidden ? ' (hidden in Onshape)' : '') },
      box, el('span', { textContent: it.label }),
      el('button', { textContent: '↓', title: `Download ${it.label}`, on: { click: () => run([it]) } }),
    ))
    return box
  })
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length
    exportBtn.disabled = n === 0
    all.checked = n === boxes.length
    all.indeterminate = n > 0 && n < boxes.length
  }
  boxes.forEach((b) => b.addEventListener('change', sync))
  all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked }); sync() })
  exportBtn.addEventListener('click', () => run(items.filter((_, i) => boxes[i].checked)))
  sync()
  say(ctx.type === 'ASSEMBLY' ? `${items.length} part instance${items.length === 1 ? '' : 's'}` : `${items.length} part${items.length === 1 ? '' : 's'}`)
}

function install() {
  if (document.getElementById('ome-btn')) return
  document.head.append(el('style', { textContent: CSS }))
  document.body.append(el('button', { id: 'ome-btn', textContent: 'Export meshes', title: 'Download the tessellation the viewer received, per part', on: { click: openPanel } }))
}

if (document.body) install()
else document.addEventListener('DOMContentLoaded', install)
