// ==UserScript==
// @name         Onshape mesh export
// @namespace    onshape-mesh-export
// @version      0.2.0
// @description  Userscript that saves the mesh the Onshape web client received, per part, from Part Studios and Assemblies as STL, OBJ or raw JSON
// @match        https://cad.onshape.com/documents/*
// @match        https://*.onshape.com/documents/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(() => {
'use strict'

// Pure mesh helpers: file writers, transforms, URL parsing, and assembly names from the REST definition.
// No DOM or network here, so it runs under Node for tests and is inlined into the userscript by the build.

function facetNormal(p, i) {
  const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2]
  const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

/** Binary STL of one or more bodies, scaled (1000 turns metres into millimetres). */
function toBinarySTL(bodies, scale = 1000, header = 'onshape-mesh-export') {
  const list = Array.isArray(bodies) ? bodies : [bodies]
  const tris = list.reduce((n, b) => n + b.positions.length / 9, 0)
  const buf = new ArrayBuffer(84 + tris * 50)
  const view = new DataView(buf)
  const head = new TextEncoder().encode(header.slice(0, 80))
  new Uint8Array(buf, 0, 80).set(head)
  view.setUint32(80, tris, true)
  let o = 84
  for (const b of list) {
    const p = b.positions
    for (let i = 0; i < p.length; i += 9) {
      const n = facetNormal(p, i)
      for (const c of n) { view.setFloat32(o, c, true); o += 4 }
      for (let k = 0; k < 9; k++) { view.setFloat32(o, p[i + k] * scale, true); o += 4 }
      o += 2 // attribute byte count
    }
  }
  return new Uint8Array(buf)
}

/** Wavefront OBJ with one `o` group per body and shared vertices welded per body. */
function toOBJ(bodies, scale = 1000) {
  const list = Array.isArray(bodies) ? bodies : [bodies]
  const out = ['# onshape-mesh-export']
  let base = 1
  for (const b of list) {
    out.push(`o ${b.name.replace(/\s+/g, '_')}`)
    const index = new Map()
    const verts = []
    const faces = []
    const p = b.positions
    for (let i = 0; i < p.length; i += 9) {
      const f = []
      for (let k = 0; k < 3; k++) {
        // Onshape's points are float32, so 7 significant digits carry all of their precision.
        const key = [0, 1, 2].map((c) => +(p[i + k * 3 + c] * scale).toPrecision(7)).join(' ')
        let id = index.get(key)
        if (id === undefined) { id = verts.length; index.set(key, id); verts.push(key) }
        f.push(id + base)
      }
      faces.push(f)
    }
    for (const v of verts) out.push(`v ${v}`)
    for (const f of faces) out.push(`f ${f[0]} ${f[1]} ${f[2]}`)
    base += verts.length
  }
  return out.join('\n') + '\n'
}

/** A file name that's safe on every OS. */
function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'part'
}

/** Parses /documents/{did}/{w|v|m}/{wvmid}/e/{eid} out of an Onshape URL. */
function parseOnshapeUrl(href) {
  const u = new URL(href)
  const m = /\/documents\/([0-9a-f]{24})\/([wvm])\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/.exec(u.pathname)
  if (!m) return null
  return { origin: u.origin, did: m[1], wvm: m[2], wvmid: m[3], eid: m[4], configuration: u.searchParams.get('configuration') || '' }
}

// ---- Assemblies ----

/**
 * Lists every part occurrence in an assembly definition (GET /assemblies/...), at every depth.
 * Each one carries its world transform (the root's `occurrences` already compose nested ones), the names along its
 * path, and the reference needed to fetch the part's tessellation. Suppressed instances, and anything under a
 * suppressed subassembly, are left out.
 */
function assemblyPartOccurrences(def) {
  const root = def.rootAssembly
  const subs = def.subAssemblies || []
  const findSub = (inst) =>
    subs.find((s) => s.documentId === inst.documentId && s.elementId === inst.elementId &&
      (s.documentMicroversion || '') === (inst.documentMicroversion || '') &&
      (s.fullConfiguration || s.configuration) === (inst.fullConfiguration || inst.configuration)) ||
    subs.find((s) => s.documentId === inst.documentId && s.elementId === inst.elementId)
  const out = []
  for (const occ of root.occurrences || []) {
    let level = root.instances || []
    const names = []
    let inst = null
    let ok = true
    for (let i = 0; i < occ.path.length; i++) {
      inst = level.find((x) => x.id === occ.path[i])
      if (!inst || inst.suppressed) { ok = false; break }
      names.push(inst.name)
      if (i < occ.path.length - 1) {
        const sub = inst.type === 'Assembly' ? findSub(inst) : null
        if (!sub) { ok = false; break }
        level = sub.instances || []
      }
    }
    if (!ok || !inst || inst.type !== 'Part') continue
    out.push({
      key: occ.path.join('/'),
      path: occ.path,
      names,
      transform: occ.transform,
      hidden: !!occ.hidden,
      part: {
        documentId: inst.documentId,
        elementId: inst.elementId,
        partId: inst.partId,
        configuration: inst.fullConfiguration || inst.configuration || 'default',
        documentMicroversion: inst.documentMicroversion,
        documentVersion: inst.documentVersion,
        isStandardContent: !!inst.isStandardContent,
      },
    })
  }
  return out
}

/**
 * Applies a 4x4 row-major transform (Onshape's occurrence `transform`, metres) to bodies.
 * A mirroring transform would turn the triangles inside out, so their winding is flipped back.
 */
function transformBodies(bodies, m, namePrefix = '') {
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8])
  return bodies.map((b) => {
    const p = b.positions
    const q = new Float64Array(p.length)
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2]
      q[i] = m[0] * x + m[1] * y + m[2] * z + m[3]
      q[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7]
      q[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11]
    }
    if (det < 0) {
      for (let i = 0; i < q.length; i += 9) {
        for (let k = 3; k < 6; k++) { const t = q[i + k]; q[i + k] = q[i + k + 3]; q[i + k + 3] = t }
      }
    }
    return { ...b, name: namePrefix || b.name, positions: q }
  })
}

// Turns the display data the Onshape web client received (decoded by the client's own reader, then made plain by
// `plainMessage`) into triangles. Pure: no DOM, IndexedDB or network, so it runs under Node for tests.
//
// What the client keeps, per Part Studio element, microversion and configuration:
//   display.GBTPartStudioDisplayData
//     partDisplayData[]            {id, name, hidden, appearance}        one per part
//     deterministicPartIdToData    {partId: GBTPartData{entityDIds[]}}   which entities make up each part
//     deterministicIdToEntity      {entityId: GBTBodyEntity{geometries[]}}
//       GBTEntityFace              {points: Float32Array xyz (metres), normals, indices: triangle strip, settingIndex}
//     partIdAndTessellationSettingToBuffers {partId: {setting: GL buffers}}  (when Onshape's GPU-buffer mode is on)
// and per assembly:
//   assemblydisplay.GBTRootAssemblyDisplayData
//     occurrences[] {occurrenceData{occurrence{path}, transform GBTBSMatrix (world), isHidden}, partIds[], fullElementId}

/** Converts a decoded Onshape message into plain objects: `$type` names the class; typed arrays are kept. */
function plainMessage(v) {
  if (v === null || typeof v !== 'object') return v
  if (ArrayBuffer.isView(v)) return v
  if (Array.isArray(v)) return v.map(plainMessage)
  const o = {}
  if (typeof v.getMessageName === 'function') o.$type = v.getMessageName()
  if (typeof v.getConfigurationString === 'function') o.$configurationString = v.getConfigurationString()
  for (const [k, x] of Object.entries(v)) {
    if (k === '_serializedByteLength' || k === 'deserializeDurationInMillis_') continue
    o[k] = plainMessage(x)
  }
  return o
}

/**
 * Appends the triangles of a triangle strip to `out` (flat xyz).
 * Onshape joins strips with repeated indices; triangles with a repeated vertex are dropped, and winding alternates
 * with the position in the whole index list, as GL_TRIANGLE_STRIP does.
 */
function stripTriangles(points, indices, out) {
  for (let i = 0; i + 2 < indices.length; i++) {
    let a = indices[i], b = indices[i + 1]
    const c = indices[i + 2]
    if (a === b || b === c || a === c) continue
    if (i & 1) { const t = a; a = b; b = t }
    out.push(points[3 * a], points[3 * a + 1], points[3 * a + 2], points[3 * b], points[3 * b + 1], points[3 * b + 2], points[3 * c], points[3 * c + 1], points[3 * c + 2])
  }
  return out
}

function trianglesList(indices, out, points) {
  for (let i = 0; i + 2 < indices.length; i += 3) {
    for (const k of [indices[i], indices[i + 1], indices[i + 2]]) out.push(points[3 * k], points[3 * k + 1], points[3 * k + 2])
  }
  return out
}

const GL_FLOAT = 5126
const GL_TRIANGLES = 4
const GL_TRIANGLE_STRIP = 5
const ARRAY_FOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }

function accessorArray(gl, index) {
  const acc = gl.bufferAccessors[index]
  const buf = gl.buffers[acc.bufferIndex].data
  const T = ARRAY_FOR[acc.glDataType]
  if (!T) throw new Error(`Unsupported GL data type ${acc.glDataType}`)
  const bytes = buf.byteOffset % T.BYTES_PER_ELEMENT ? buf.slice() : buf
  return new T(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / T.BYTES_PER_ELEMENT))
}

function applyMatrix12(p, m) {
  const out = new Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2]
    out[i] = m[0] * x + m[1] * y + m[2] * z + m[3]
    out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7]
    out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11]
  }
  return out
}

/** Triangles from a GBTGLDisplayData-shaped object (glTF-like buffers, accessors and nodes of drawables). */
function glTriangles(gl, out = []) {
  for (const node of gl.nodes || []) {
    const m = node.transform && node.transform[0] ? matrixToArray(node.transform[0]) : null
    for (const d of node.drawables || []) {
      if (d.primitiveType !== GL_TRIANGLES && d.primitiveType !== GL_TRIANGLE_STRIP) continue
      if (gl.bufferAccessors[d.attributes.point].glDataType !== GL_FLOAT) throw new Error('GL positions are not float32')
      let points = accessorArray(gl, d.attributes.point)
      if (m && !isIdentity(m)) points = applyMatrix12(points, m)
      const indices = accessorArray(gl, d.indices)
      if (d.primitiveType === GL_TRIANGLE_STRIP) stripTriangles(points, indices, out)
      else trianglesList(indices, out, points)
    }
  }
  return out
}

/** GBTBSMatrix {m00..m23} (rows of a 3x4 affine matrix) as a 16-number row-major 4x4. */
function matrixToArray(t) {
  return [t.m00, t.m01, t.m02, t.m03, t.m10, t.m11, t.m12, t.m13, t.m20, t.m21, t.m22, t.m23, 0, 0, 0, 1]
}

function isIdentity(m) {
  return m[0] === 1 && m[5] === 1 && m[10] === 1 && !m[1] && !m[2] && !m[3] && !m[4] && !m[6] && !m[7] && !m[8] && !m[9] && !m[11]
}

/** Parts of a Part Studio, from its display data: [{id, name, hidden, color}]. */
function studioParts(psdd) {
  return (psdd.partDisplayData || []).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    hidden: !!p.hidden,
    color: p.appearance && p.appearance.color && p.appearance.color.length >= 3 ? [...p.appearance.color].slice(0, 3) : null,
  }))
}

/**
 * The triangles of one part (flat xyz, metres), gathered from any number of display-data messages for the same Part
 * Studio microversion and configuration: the element's own record and the per-part tessellation records.
 * Where the client holds a face at several tessellation settings, the finest one is used.
 * Returns null when none of the messages hold geometry for the part.
 */
function partTriangles(partId, messages) {
  let entityIds = null
  const faces = new Map()
  let gl = null
  for (const m of messages) {
    const pd = m.deterministicPartIdToData && m.deterministicPartIdToData[partId]
    if (pd && pd.entityDIds && pd.entityDIds.length) entityIds = pd.entityDIds
    for (const [id, ent] of Object.entries(m.deterministicIdToEntity || {})) {
      for (const g of ent.geometries || []) {
        if (g.$type !== 'display.GBTEntityFace' || !g.indices || !g.indices.length || !g.points || !g.points.length) continue
        const prev = faces.get(id)
        if (!prev || (g.settingIndex || 0) > (prev.settingIndex || 0)) faces.set(id, g)
      }
    }
    const bufs = m.partIdAndTessellationSettingToBuffers && m.partIdAndTessellationSettingToBuffers[partId]
    if (bufs) {
      const best = Object.keys(bufs).map(Number).sort((a, b) => b - a).find((s) => bufs[s])
      if (best !== undefined) gl = bufs[best]
    }
  }
  const out = []
  if (entityIds) for (const id of entityIds) { const f = faces.get(id); if (f) stripTriangles(f.points, f.indices, out) }
  if (!out.length && gl) {
    if (!gl.buffers || !gl.nodes) throw new Error(`Part ${partId} uses a GPU-buffer format this script doesn't read (${gl.$type || 'unknown'})`)
    glTriangles(gl, out)
  }
  return out.length ? new Float64Array(out) : null
}

/** The faces of one part as the client holds them, for raw export. */
function partFaces(partId, messages) {
  let entityIds = []
  const ents = {}
  for (const m of messages) {
    const pd = m.deterministicPartIdToData && m.deterministicPartIdToData[partId]
    if (pd && pd.entityDIds && pd.entityDIds.length) entityIds = pd.entityDIds
    Object.assign(ents, m.deterministicIdToEntity || {})
  }
  const faces = []
  for (const id of entityIds) {
    for (const g of (ents[id] && ents[id].geometries) || []) {
      if (g.$type !== 'display.GBTEntityFace') continue
      faces.push({ id, settingIndex: g.settingIndex, points: Array.from(g.points), normals: Array.from(g.normals || []), indices: Array.from(g.indices), primitive: 'TRIANGLE_STRIP' })
    }
  }
  return faces
}

/**
 * Part occurrences of an assembly, from its root display data. One item per (occurrence, part), with the world
 * transform the viewer draws it with and the Part Studio record that holds its tessellation.
 */
function assemblyItems(root) {
  const items = []
  for (const occ of root.occurrences || []) {
    const od = occ.occurrenceData || {}
    const path = (od.occurrence && od.occurrence.path) || []
    const fe = occ.fullElementId || {}
    const mvc = fe.microversionIdAndConfiguration || {}
    const source = {
      documentId: fe.documentId || '',
      elementId: fe.elementId || occ.elementId,
      microversionId: (mvc.microversion && mvc.microversion.theId) || (fe.microversionId && fe.microversionId.theId) || '',
      configuration: mvc.$configurationString || '',
    }
    for (const partId of occ.partIds || []) {
      items.push({
        key: path.join('/') + (occ.partIds.length > 1 ? '#' + partId : ''),
        path,
        partId,
        hidden: !!(occ.isHidden || od.isHidden),
        transform: matrixToArray(od.transform),
        source,
      })
    }
  }
  return items
}

/** Key for one Part Studio record in the client's cache. */
const sourceKey = (s) => [s.elementId, s.microversionId, s.configuration].join('|')

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

})()
