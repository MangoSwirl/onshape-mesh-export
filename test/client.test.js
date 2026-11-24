// Tests against display data captured from the live Onshape client (IndexedDB CacheDbV7, decoded by the client's
// own reader). Volumes are checked against Onshape's mass properties for the same parts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { partTriangles, assemblyItems, glTriangles, stripTriangles, studioParts, sourceKey } from '../src/client.js'

const load = (name) =>
  JSON.parse(readFileSync(new URL(`fixtures/client-${name}.json`, import.meta.url), 'utf8'), (k, v) =>
    v && typeof v === 'object' && v.$typed ? new globalThis[v.$typed](v.v) : v)

const ps = load('psSlim')
const tessShaft = load('tessJKD')
const tessBlock = load('tessJND')
const mass = load('massVolumesCm3')

function volumeCm3(p) {
  let v = 0
  for (let i = 0; i < p.length; i += 9) {
    v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])
  }
  return (v / 6) * 1e6
}

function unpairedEdges(p) {
  const key = (i) => `${p[i]},${p[i + 1]},${p[i + 2]}`
  const e = new Set()
  for (let i = 0; i < p.length; i += 9) {
    const v = [key(i), key(i + 3), key(i + 6)]
    for (let k = 0; k < 3; k++) e.add(v[k] + '|' + v[(k + 1) % 3])
  }
  let n = 0
  for (const x of e) { const [a, b] = x.split('|'); if (!e.has(b + '|' + a)) n++ }
  return n
}

test('strip decoding: a quad [0,1,2,3,3] gives two triangles with the same winding', () => {
  const quad = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]
  const t = stripTriangles(quad, [0, 1, 2, 3, 3], [])
  assert.equal(t.length, 18)
  const nz = (o) => (t[o + 3] - t[o]) * (t[o + 7] - t[o + 1]) - (t[o + 4] - t[o + 1]) * (t[o + 6] - t[o])
  assert.ok(nz(0) > 0 && nz(9) > 0)
})

test('Part Studio parts and names come from the display data', () => {
  assert.deepEqual(studioParts(ps).map((p) => p.name), ['Base', 'Shaft', 'Block', 'Gear A', 'Gear B', 'Rack'])
})

test('box part: closed, outward, exact volume', () => {
  const t = partTriangles('JND', [ps, tessBlock])
  assert.equal(t.length / 9, 12)
  assert.equal(unpairedEdges(t), 0)
  assert.ok(Math.abs(volumeCm3(t) - mass.JND) < 1e-4, "float32 points")
})

test('curved part: volume within tessellation error of Onshape mass properties', () => {
  const t = partTriangles('JKD', [ps, tessShaft])
  const v = volumeCm3(t)
  assert.ok(v > 0, 'outward winding')
  assert.ok(Math.abs(v - mass.JKD) / mass.JKD < 0.005, `volume ${v} vs ${mass.JKD}`)
})

test('a part with no geometry in the given messages returns null', () => {
  assert.equal(partTriangles('JQD', [tessShaft]), null)
})

test('assembly: one item per part occurrence, world transforms, cache source', () => {
  const items = assemblyItems(load('asm'))
  assert.equal(items.length, 7)
  const nested = items.find((i) => i.key === 'Mbddd/pSUAQLo4eq7/MbyBmnQJoMAbnnYor')
  assert.equal(nested.partId, 'JKD')
  assert.deepEqual(nested.transform.map((x) => +x.toFixed(4) || 0), [0, -1, 0, 0.03, 1, 0, 0, -0.15, 0, 0, 1, -0.035, 0, 0, 0, 1])
  assert.equal(nested.source.elementId, '6278772797e780b2a0fe76f3')
  assert.equal(nested.source.microversionId, '37a675a0562783b0254cc9f3')
  assert.equal(nested.source.configuration, '')
})

test('configured assembly: cache keys carry the client’s configuration strings', () => {
  const cfgs = assemblyItems(load('asmCfg')).map((i) => i.source.configuration).sort()
  assert.deepEqual(cfgs, ['', '(HoleDia:0.006m)', '(HoleDia:0.006m)', '(Size:Large)(WithPeg:false)'])
  assert.equal(new Set(assemblyItems(load('asmCfg')).map((i) => sourceKey(i.source) + i.partId)).size, 4)
})

test('GL buffer form (float32 points, uint32 strip indices): mesh tetrahedron', () => {
  const t = glTriangles(load('tetraPreview'))
  assert.equal(t.length / 9, 4)
  assert.equal(unpairedEdges(t), 0)
  assert.ok(Math.abs(volumeCm3(t) - 0.01 ** 3 / 6 * 1e6) < 1e-6)
})
