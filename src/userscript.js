// Browser side: a small panel in an Onshape Part Studio or Assembly tab that lists the parts and downloads each one's
// tessellation. It calls Onshape's own REST API from the page, so it uses the signed-in session: no API keys, no quota.

const QUALITY = {
  default: { label: 'Onshape default', params: {} },
  fine: { label: 'Fine', params: { chordTolerance: 0.00005, angleTolerance: 5 } },
  coarse: { label: 'Coarse', params: { chordTolerance: 0.001, angleTolerance: 15 } },
}
const UNITS = { mm: 1000, m: 1, in: 1 / 0.0254 }
const ACCEPT = 'application/json;charset=UTF-8; qs=0.09'
const PARALLEL = 4

async function api(loc, path, params = {}) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined && v !== null) q.set(k, String(v))
  const url = `${loc.origin}/api/v6${path}${q.size ? '?' + q : ''}`
  const res = await fetch(url, { credentials: 'include', headers: { Accept: ACCEPT } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText} from ${path}${body ? ': ' + body.slice(0, 200) : ''}`)
  }
  return res.json()
}

const wvmPath = (loc) => `/d/${loc.did}/${loc.wvm}/${loc.wvmid}`

async function elementInfo(loc) {
  const els = await api(loc, `/documents${wvmPath(loc)}/elements`, { elementId: loc.eid })
  const el = (Array.isArray(els) ? els : []).find((e) => e.id === loc.eid) || els[0]
  if (!el) throw new Error('Could not read this tab’s element')
  return { type: el.elementType, name: el.name || 'export' }
}

// An export item is one thing in the list: a part in a Part Studio, or a part occurrence in an assembly.
// { key, label, hidden, source: {path, params}, transform? , fileBase }

async function partStudioItems(loc) {
  const parts = await api(loc, `/parts${wvmPath(loc)}/e/${loc.eid}`, { configuration: loc.configuration, withThumbnails: false })
  return parts
    .filter((p) => p.bodyType !== 'composite')
    .map((p) => ({
      key: p.partId,
      label: p.name,
      hidden: !!p.isHidden,
      fileBase: p.name,
      source: { path: `/partstudios${wvmPath(loc)}/e/${loc.eid}/tessellatedfaces`, params: { partId: p.partId, configuration: loc.configuration } },
    }))
}

async function assemblyItems(loc) {
  const def = await api(loc, `/assemblies${wvmPath(loc)}/e/${loc.eid}`, {
    configuration: loc.configuration,
    includeMateFeatures: false,
    includeMateConnectors: false,
    includeNonSolids: false,
  })
  return assemblyPartOccurrences(def).map((o) => {
    const p = o.part
    // Parts from this document are read from the tab's own workspace or version. Parts from other documents
    // (including standard content) are read at the version the assembly links to, through this document.
    const same = p.documentId === loc.did
    const where = same ? wvmPath(loc) : p.documentVersion ? `/d/${p.documentId}/v/${p.documentVersion}` : `/d/${p.documentId}/m/${p.documentMicroversion}`
    const configuration = p.configuration && p.configuration !== 'default' ? p.configuration : ''
    return {
      key: o.key,
      label: o.names.join(' › '),
      hidden: o.hidden,
      fileBase: o.names.join(' - '),
      transform: o.transform,
      sourceKey: partSourceKey(p),
      source: {
        path: `/partstudios${where}/e/${p.elementId}/tessellatedfaces`,
        params: { partId: p.partId, configuration, ...(same ? {} : { linkDocumentId: loc.did }) },
      },
    }
  })
}

function tessellationLoader(loc, quality) {
  const cache = new Map()
  return (item) => {
    const k = item.sourceKey || item.key
    if (!cache.has(k)) {
      cache.set(k, api(loc, item.source.path, {
        ...item.source.params,
        outputIndexTable: true,
        outputFacetNormals: false,
        outputVertexNormals: false,
        ...QUALITY[quality].params,
      }))
    }
    return cache.get(k)
  }
}

async function eachLimited(items, n, fn) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i) }
  }))
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

/** Bodies for one item in metres, placed in the assembly when asked. */
function itemBodies(item, resp, placed) {
  const bodies = bodiesFromResponse(resp).filter((b) => b.positions.length)
  if (!bodies.length) throw new Error('Onshape returned no facets')
  return placed && item.transform ? transformBodies(bodies, item.transform, item.label) : bodies.map((b) => ({ ...b, name: item.label }))
}

function writeMesh(base, bodies, opts) {
  const scale = UNITS[opts.units]
  if (opts.format === 'obj') download(`${safeFileName(base)}.obj`, toOBJ(bodies, scale), 'model/obj')
  else download(`${safeFileName(base)}.stl`, toBinarySTL(bodies, scale, `${base} (${opts.units})`), 'model/stl')
}

const rawRecord = (item, resp, placed) => ({ name: item.label, ...(placed && item.transform ? { transform: item.transform } : {}), tessellation: resp })

/** Fetches and saves the chosen items, one file each or all in one. Returns the failures. */
async function exportItems(loc, ctx, items, opts, progress) {
  const load = tessellationLoader(loc, opts.quality)
  const placed = ctx.type === 'ASSEMBLY' && opts.placed
  const failed = []
  const collected = []
  let done = 0
  await eachLimited(items, PARALLEL, async (item, i) => {
    try {
      const resp = await load(item)
      if (opts.combine) collected[i] = opts.format === 'json' ? rawRecord(item, resp, placed) : itemBodies(item, resp, placed)
      else if (opts.format === 'json') download(`${safeFileName(item.fileBase)}.tessellation.json`, JSON.stringify(rawRecord(item, resp, placed)), 'application/json')
      else writeMesh(item.fileBase, itemBodies(item, resp, placed), opts)
    } catch (e) {
      failed.push(`${item.label}: ${e.message}`)
      console.error('[onshape-mesh-export]', item.label, e)
    }
    progress(++done, items.length, item.label)
  })
  if (opts.combine) {
    const got = collected.filter(Boolean)
    if (got.length) {
      if (opts.format === 'json') download(`${safeFileName(ctx.name)}.tessellation.json`, JSON.stringify(got), 'application/json')
      else writeMesh(ctx.name, got.flat(), opts)
    }
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
const DEFAULT_PREFS = { format: 'stl', units: 'mm', quality: 'default', combine: false, placed: true }
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } } catch { return { ...DEFAULT_PREFS } }
}
function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch {} }

async function openPanel() {
  document.getElementById('ome-panel')?.remove()
  const loc = parseOnshapeUrl(location.href)
  const msg = el('div', { className: 'msg' })
  const list = el('ul')
  const prefs = loadPrefs()
  const fmt = select('Format', { stl: 'STL (binary)', obj: 'OBJ', json: 'Raw JSON' }, prefs.format)
  const units = select('Units', { mm: 'mm', m: 'm', in: 'in' }, prefs.units)
  const quality = select('Quality', Object.fromEntries(Object.entries(QUALITY).map(([k, q]) => [k, q.label])), prefs.quality)
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
      el('div', { className: 'row' }, fmt, units, quality),
      el('label', {}, combine, 'One file'), placedLabel, el('label', {}, all, 'All')),
    list,
    el('footer', {}, msg, exportBtn),
  )
  document.body.append(panel)
  const say = (text, error = false) => { msg.textContent = text; msg.className = error ? 'msg err' : 'msg' }
  const opts = () => {
    const o = { format: fmt.value, units: units.value, quality: quality.value, combine: combine.checked, placed: placed.checked }
    savePrefs(o)
    return o
  }

  if (!loc) return say('Open a Part Studio or Assembly tab first.', true)
  say('Loading…')
  let ctx, items
  try {
    ctx = await elementInfo(loc)
    if (ctx.type === 'PARTSTUDIO') items = await partStudioItems(loc)
    else if (ctx.type === 'ASSEMBLY') items = await assemblyItems(loc)
    else return say('Open a Part Studio or Assembly tab.', true)
  } catch (e) {
    return say(e.message, true)
  }
  title.textContent = ctx.name
  title.title = ctx.name
  if (ctx.type === 'ASSEMBLY') placedLabel.style.display = ''
  if (!items.length) return say(ctx.type === 'ASSEMBLY' ? 'No parts in this assembly.' : 'No parts in this Part Studio.')

  const run = async (chosen) => {
    exportBtn.disabled = true
    const failed = await exportItems(loc, ctx, chosen, opts(), (n, total, label) => say(`Fetched ${n}/${total}: ${label}`))
    sync()
    if (failed.length) say(`${failed.length} of ${chosen.length} failed. ${failed[0]}`, true)
    else say(`Downloaded ${chosen.length} part${chosen.length === 1 ? '' : 's'}${opts().combine && chosen.length > 1 ? ' in one file' : ''}.`)
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
  const unique = new Set(items.map((i) => i.sourceKey || i.key)).size
  say(ctx.type === 'ASSEMBLY' ? `${items.length} part instance${items.length === 1 ? '' : 's'} (${unique} distinct)` : `${items.length} part${items.length === 1 ? '' : 's'}`)
}

function install() {
  if (document.getElementById('ome-btn')) return
  document.head.append(el('style', { textContent: CSS }))
  document.body.append(el('button', { id: 'ome-btn', textContent: 'Export meshes', title: 'Download part tessellations', on: { click: openPanel } }))
}

if (document.body) install()
else document.addEventListener('DOMContentLoaded', install)
