// Pure conversion from Onshape's tessellatedfaces response to mesh files.
// No DOM or network here, so it runs under Node for tests and is inlined into the userscript by the build.

/** Reads a point given as [x, y, z] or as a BTVector3d {x, y, z}. */
function pointOf(p) {
  if (Array.isArray(p)) return [p[0], p[1], p[2]]
  if (p && typeof p === 'object') return [p.x, p.y, p.z]
  throw new TypeError('Unrecognised point: ' + JSON.stringify(p))
}

/**
 * Turns a tessellatedfaces response into one triangle soup per body.
 * Handles both shapes Onshape returns: facets with their own `vertices`, and facets with `indices`
 * into a point table (the body's `facetPoints`, or the response's top-level one).
 * Units stay as Onshape sends them (metres).
 */
export function bodiesFromResponse(resp) {
  const shared = resp.facetPoints || []
  return (resp.bodies || []).map((body) => {
    const table = body.facetPoints && body.facetPoints.length ? body.facetPoints : shared
    const positions = []
    let faces = 0
    for (const face of body.faces || []) {
      faces++
      for (const facet of face.facets || []) {
        let tri
        if (facet.vertices && facet.vertices.length >= 3) tri = facet.vertices.slice(0, 3).map(pointOf)
        else if (facet.indices && facet.indices.length >= 3) {
          tri = facet.indices.slice(0, 3).map((i) => {
            if (i < 0 || i >= table.length) throw new RangeError(`Facet index ${i} outside point table of ${table.length}`)
            return pointOf(table[i])
          })
        } else continue
        for (const v of tri) positions.push(v[0], v[1], v[2])
      }
    }
    return {
      id: body.id,
      name: body.name || body.id,
      bodyType: body.bodyType,
      faceCount: faces,
      positions: new Float64Array(positions),
    }
  })
}

function facetNormal(p, i) {
  const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2]
  const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

/** Binary STL of one or more bodies, scaled (1000 turns metres into millimetres). */
export function toBinarySTL(bodies, scale = 1000, header = 'onshape-mesh-export') {
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
export function toOBJ(bodies, scale = 1000) {
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
        const x = p[i + k * 3] * scale, y = p[i + k * 3 + 1] * scale, z = p[i + k * 3 + 2] * scale
        const key = `${x} ${y} ${z}`
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
export function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'part'
}

/** Parses /documents/{did}/{w|v|m}/{wvmid}/e/{eid} out of an Onshape URL. */
export function parseOnshapeUrl(href) {
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
export function assemblyPartOccurrences(def) {
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

/** Identifies one part definition, so instances of the same part share a single tessellation request. */
export function partSourceKey(part) {
  return [part.documentId, part.documentVersion || part.documentMicroversion || '', part.elementId, part.partId, part.configuration || 'default'].join('|')
}

/**
 * Applies a 4x4 row-major transform (Onshape's occurrence `transform`, metres) to bodies.
 * A mirroring transform would turn the triangles inside out, so their winding is flipped back.
 */
export function transformBodies(bodies, m, namePrefix = '') {
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
