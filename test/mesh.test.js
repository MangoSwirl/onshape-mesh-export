import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toBinarySTL, toOBJ, parseOnshapeUrl, safeFileName, assemblyPartOccurrences, transformBodies } from '../src/mesh.js'
import { partTriangles } from '../src/client.js'

const load = (name) =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'), (k, v) =>
    v && typeof v === 'object' && v.$typed ? new globalThis[v.$typed](v.v) : v)

// The Shaft as the Onshape client received it.
const shaft = { name: 'Shaft', positions: partTriangles('JKD', [load('client-psSlim'), load('client-tessJKD')]) }

test('binary STL layout and scaling', () => {
  const stl = toBinarySTL(shaft, 1000)
  const n = shaft.positions.length / 9
  const view = new DataView(stl.buffer)
  assert.equal(stl.length, 84 + 50 * n)
  assert.equal(view.getUint32(80, true), n)
  assert.ok(Math.abs(view.getFloat32(84 + 12, true) - shaft.positions[0] * 1000) < 1e-3)
  const nrm = [0, 1, 2].map((k) => view.getFloat32(84 + 4 * k, true))
  assert.ok(Math.abs(Math.hypot(...nrm) - 1) < 1e-5)
})

test('OBJ welds shared vertices', () => {
  const obj = toOBJ(shaft, 1000)
  const v = obj.split('\n').filter((l) => l.startsWith('v ')).length
  const f = obj.split('\n').filter((l) => l.startsWith('f ')).length
  assert.equal(f, shaft.positions.length / 9)
  assert.ok(v < f && v >= 4)
  assert.ok(obj.includes('o Shaft'))
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

// Instance names come from the REST assembly definition (the client's cache doesn't keep them).
const asm = load('assembly-definition')

test('assembly names: every part occurrence at every depth, keyed by path', () => {
  const occ = assemblyPartOccurrences(asm)
  assert.equal(occ.length, 7)
  const nested = occ.filter((o) => o.path.length === 2).map((o) => o.names.join(' › ')).sort()
  assert.deepEqual(nested, ['Assembly 2 <1> › Rack <1>', 'Assembly 2 <1> › Shaft <1>'])
})

test('assembly names: suppressed instances and their children drop out', () => {
  const copy = structuredClone(asm)
  copy.rootAssembly.instances.find((i) => i.type === 'Assembly').suppressed = true
  assert.equal(assemblyPartOccurrences(copy).length, 5)
})

test('transform: row-major rotation and translation, winding kept under mirroring', () => {
  const b = { name: 't', positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }
  const rotZ = [0, -1, 0, 10, 1, 0, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1]
  assert.deepEqual([...transformBodies([b], rotZ)[0].positions], [10, 20, 30, 10, 21, 30, 9, 20, 30])
  const mirrorX = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const m = transformBodies([b], mirrorX)[0].positions
  const nz = (m[3] - m[0]) * (m[7] - m[1]) - (m[4] - m[1]) * (m[6] - m[0])
  assert.ok(nz > 0, 'normal still +z after mirroring')
})
