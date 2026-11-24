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
export function plainMessage(v) {
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
export function stripTriangles(points, indices, out) {
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
export function glTriangles(gl, out = []) {
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
export function matrixToArray(t) {
  return [t.m00, t.m01, t.m02, t.m03, t.m10, t.m11, t.m12, t.m13, t.m20, t.m21, t.m22, t.m23, 0, 0, 0, 1]
}

function isIdentity(m) {
  return m[0] === 1 && m[5] === 1 && m[10] === 1 && !m[1] && !m[2] && !m[3] && !m[4] && !m[6] && !m[7] && !m[8] && !m[9] && !m[11]
}

/** Parts of a Part Studio, from its display data: [{id, name, hidden, color}]. */
export function studioParts(psdd) {
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
export function partTriangles(partId, messages) {
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
export function partFaces(partId, messages) {
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
export function assemblyItems(root) {
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
export const sourceKey = (s) => [s.elementId, s.microversionId, s.configuration].join('|')
