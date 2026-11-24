import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bodiesFromResponse, toBinarySTL, toOBJ, parseOnshapeUrl, safeFileName } from '../src/mesh.js'

// Trimmed from a real /tessellatedfaces response (outputIndexTable=true): one body, indices into top-level facetPoints.
const indexed = JSON.parse(readFileSync(new URL('fixtures/indexed-part.json', import.meta.url), 'utf8'))

test('indexed response: every facet becomes one triangle', () => {
  const [b] = bodiesFromResponse(indexed)
  const facets = indexed.bodies[0].faces.reduce((n, f) => n + f.facets.length, 0)
  assert.equal(b.name, 'Part 2')
  assert.equal(b.positions.length, facets * 9)
  assert.equal(b.positions[0], indexed.facetPoints[indexed.bodies[0].faces[0].facets[0].indices[0]].x)
})

test('indexed response gives a closed solid with outward normals', () => {
  const [b] = bodiesFromResponse(indexed)
  // Every edge of a closed manifold is shared by exactly two triangles in opposite directions.
  const key = (i) => [b.positions[i], b.positions[i + 1], b.positions[i + 2]].join(',')
  const edges = new Map()
  for (let i = 0; i < b.positions.length; i += 9) {
    const v = [key(i), key(i + 3), key(i + 6)]
    for (let k = 0; k < 3; k++) {
      const e = v[k] + '>' + v[(k + 1) % 3]
      edges.set(e, (edges.get(e) || 0) + 1)
    }
  }
  for (const [e, n] of edges) {
    assert.equal(n, 1, `edge ${e} used ${n} times`)
    const [a, c] = e.split('>')
    assert.ok(edges.has(c + '>' + a), `edge ${e} has no twin`)
  }
  // Signed volume (divergence theorem) is positive when facets wind outward.
  let vol = 0
  const p = b.positions
  for (let i = 0; i < p.length; i += 9) {
    vol += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])
  }
  assert.ok(vol / 6 > 0)
})

test('vertex-list response (outputIndexTable=false) with array and object points', () => {
  const resp = {
    bodies: [{
      id: 'JHD', name: 'Tri', faces: [{ id: 'F', facets: [
        { vertices: [[0, 0, 0], [0.001, 0, 0], [0, 0.001, 0]] },
        { vertices: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0.001, z: 0 }, { x: 0, y: 0, z: 0.001 }] },
      ] }],
    }],
  }
  const [b] = bodiesFromResponse(resp)
  assert.deepEqual([...b.positions.slice(0, 9)], [0, 0, 0, 0.001, 0, 0, 0, 0.001, 0])
  assert.equal(b.positions.length, 18)
})

test('out-of-range index fails loudly', () => {
  assert.throws(() => bodiesFromResponse({ facetPoints: [], bodies: [{ id: 'a', faces: [{ facets: [{ indices: [0, 1, 2] }] }] }] }), RangeError)
})

test('binary STL layout and scaling', () => {
  const [b] = bodiesFromResponse(indexed)
  const stl = toBinarySTL(b, 1000)
  const n = b.positions.length / 9
  const view = new DataView(stl.buffer)
  assert.equal(stl.length, 84 + 50 * n)
  assert.equal(view.getUint32(80, true), n)
  assert.ok(Math.abs(view.getFloat32(84 + 12, true) - b.positions[0] * 1000) < 1e-3)
  const nrm = [0, 1, 2].map((k) => view.getFloat32(84 + 4 * k, true))
  assert.ok(Math.abs(Math.hypot(...nrm) - 1) < 1e-5)
})

test('OBJ welds shared vertices', () => {
  const [b] = bodiesFromResponse(indexed)
  const obj = toOBJ(b, 1000)
  const v = obj.split('\n').filter((l) => l.startsWith('v ')).length
  const f = obj.split('\n').filter((l) => l.startsWith('f ')).length
  assert.equal(f, b.positions.length / 9)
  assert.ok(v < f * 3 && v >= 4)
  assert.ok(obj.includes('o Part_2'))
})

test('URL parsing', () => {
  const loc = parseOnshapeUrl('https://cad.onshape.com/documents/b7ca293f81b76257c6d8d288/w/1a2b3c4d5e6f708192a3b4c5/e/00a9354f9e3404878892e34f?configuration=List_x%3Da')
  assert.deepEqual(loc, { origin: 'https://cad.onshape.com', did: 'b7ca293f81b76257c6d8d288', wvm: 'w', wvmid: '1a2b3c4d5e6f708192a3b4c5', eid: '00a9354f9e3404878892e34f', configuration: 'List_x=a' })
  assert.equal(parseOnshapeUrl('https://cad.onshape.com/documents'), null)
})

test('safe file names', () => {
  assert.equal(safeFileName('Arm: plate / v2?'), 'Arm_ plate _ v2_')
  assert.equal(safeFileName('   '), 'part')
})
