// Browser side: a small panel in an Onshape Part Studio tab that lists the parts and downloads each one's tessellation.
// It calls Onshape's own REST API from the page, so it uses the signed-in session: no API keys, no quota.

const QUALITY = {
  default: { label: 'Onshape default', params: {} },
  fine: { label: 'Fine', params: { chordTolerance: 0.00005, angleTolerance: 5 } },
  coarse: { label: 'Coarse', params: { chordTolerance: 0.001, angleTolerance: 15 } },
}
const UNITS = { mm: 1000, m: 1, in: 1 / 0.0254 }
const ACCEPT = 'application/json;charset=UTF-8; qs=0.09'

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

const docPath = (loc) => `/d/${loc.did}/${loc.wvm}/${loc.wvmid}/e/${loc.eid}`

async function listParts(loc) {
  const parts = await api(loc, `/parts${docPath(loc)}`, { configuration: loc.configuration, withThumbnails: false })
  return parts.filter((p) => p.bodyType !== 'composite')
}

async function fetchPartTessellation(loc, partId, quality) {
  return api(loc, `/partstudios${docPath(loc)}/tessellatedfaces`, {
    partId,
    configuration: loc.configuration,
    outputIndexTable: true,
    outputFacetNormals: false,
    outputVertexNormals: false,
    ...QUALITY[quality].params,
  })
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

async function exportPart(loc, part, opts) {
  const resp = await fetchPartTessellation(loc, part.partId, opts.quality)
  const base = safeFileName(part.name)
  if (opts.format === 'json') {
    download(`${base}.tessellation.json`, JSON.stringify(resp), 'application/json')
    return
  }
  const bodies = bodiesFromResponse(resp).filter((b) => b.positions.length)
  if (!bodies.length) throw new Error(`${part.name}: Onshape returned no facets`)
  const scale = UNITS[opts.units]
  if (opts.format === 'obj') download(`${base}.obj`, toOBJ(bodies, scale), 'model/obj')
  else download(`${base}.stl`, toBinarySTL(bodies, scale, `${part.name} (${opts.units})`), 'model/stl')
}

// ---- UI ----

const CSS = `
#ome-btn{position:fixed;z-index:2147483646;left:12px;bottom:12px;padding:6px 10px;border:0;border-radius:6px;
  font:600 12px system-ui,sans-serif;color:#fff;background:#2b5fb4;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer}
#ome-panel{position:fixed;z-index:2147483647;left:12px;bottom:48px;width:340px;max-height:70vh;display:flex;flex-direction:column;
  font:13px/1.4 system-ui,sans-serif;color:#1d2733;background:#fff;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.3)}
#ome-panel header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;font-weight:600;border-bottom:1px solid #e3e7ec}
#ome-panel .opts{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #e3e7ec}
#ome-panel select{font:inherit;flex:1;min-width:0}
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
function loadPrefs() {
  try { return { format: 'stl', units: 'mm', quality: 'default', ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } } catch { return { format: 'stl', units: 'mm', quality: 'default' } }
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
  const opts = () => {
    const o = { format: fmt.value, units: units.value, quality: quality.value }
    savePrefs(o)
    return o
  }
  const exportBtn = el('button', { textContent: 'Download selected', disabled: true })
  const panel = el('div', { id: 'ome-panel' },
    el('header', {}, 'Export part meshes', el('button', { textContent: '✕', title: 'Close', on: { click: () => panel.remove() } })),
    el('div', { className: 'opts' }, fmt, units, quality),
    list,
    el('footer', {}, msg, exportBtn),
  )
  document.body.append(panel)
  const say = (text, error = false) => { msg.textContent = text; msg.className = error ? 'msg err' : 'msg' }

  if (!loc) return say('Open a Part Studio tab first.', true)
  say('Loading parts…')
  let parts
  try {
    parts = await listParts(loc)
  } catch (e) {
    return say(/404|400/.test(e.message) ? 'This tab is not a Part Studio.' : e.message, true)
  }
  if (!parts.length) return say('No parts in this Part Studio.')

  const run = async (chosen) => {
    exportBtn.disabled = true
    const o = opts()
    let done = 0
    const failed = []
    for (const p of chosen) {
      say(`Downloading ${++done}/${chosen.length}: ${p.name}`)
      try { await exportPart(loc, p, o) } catch (e) { failed.push(`${p.name}: ${e.message}`); console.error('[onshape-mesh-export]', e) }
    }
    exportBtn.disabled = false
    if (failed.length) say(`${failed.length} failed. ${failed[0]}`, true)
    else say(`Downloaded ${chosen.length} part${chosen.length === 1 ? '' : 's'}.`)
  }

  const boxes = parts.map((p) => {
    const box = el('input', { type: 'checkbox', checked: !p.isHidden })
    list.append(el('li', { className: p.isHidden ? 'hidden' : '', title: p.isHidden ? 'Hidden in Onshape' : '' },
      box, el('span', { textContent: p.name }),
      el('button', { textContent: '↓', title: `Download ${p.name}`, on: { click: () => run([p]) } }),
    ))
    return box
  })
  const sync = () => { exportBtn.disabled = !boxes.some((b) => b.checked) }
  boxes.forEach((b) => b.addEventListener('change', sync))
  exportBtn.addEventListener('click', () => run(parts.filter((_, i) => boxes[i].checked)))
  sync()
  say(`${parts.length} part${parts.length === 1 ? '' : 's'}`)
}

function install() {
  if (document.getElementById('ome-btn')) return
  document.head.append(el('style', { textContent: CSS }))
  document.body.append(el('button', { id: 'ome-btn', textContent: 'Export meshes', title: 'Download part tessellations', on: { click: openPanel } }))
}

if (document.body) install()
else document.addEventListener('DOMContentLoaded', install)
