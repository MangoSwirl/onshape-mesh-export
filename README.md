# Onshape mesh export

A userscript that downloads the tessellated (triangle mesh) geometry Onshape computes for each part in a Part Studio. It saves it as binary STL, OBJ or Onshape's raw JSON.

It runs inside your signed-in Onshape tab and calls Onshape's own `tessellatedfaces` endpoint with your session. You don't need API keys and it doesn't use any API quota. Each part is requested and saved separately.

## Install

1. Install a userscript manager: [Violentmonkey](https://violentmonkey.github.io/) or Tampermonkey.
2. Open [`dist/onshape-mesh-export.user.js`](dist/onshape-mesh-export.user.js) (the raw file) and accept the install prompt.

## Use

1. Open a Part Studio tab in Onshape.
2. Click **Export meshes** at the bottom left.
3. Choose the format, the units and the quality.
4. Click ↓ next to a part, or tick the parts you want and click **Download selected**. Hidden parts start unticked.

| Option | Values |
|---|---|
| Format | STL (binary), OBJ (vertices welded, one `o` group per body), raw JSON (the API response for the part, unchanged) |
| Units | mm (default), m, in. Onshape sends metres; STL and OBJ are scaled. |
| Quality | Onshape default, Fine (chord 0.05 mm, 5°), Coarse (chord 1 mm, 15°) |

If the document URL includes a `?configuration=` parameter, the script uses that configuration.

## Limits

- The script exports Part Studios only. Assemblies would need each instance's transform applied, and it doesn't do that.
- Your browser may ask once whether to allow multiple downloads.
- The mesh comes from the REST API, which uses the same tessellation as Onshape's viewer. The viewer receives its geometry over its own websocket, and the script doesn't read that.

## Develop

```sh
npm run build   # writes dist/onshape-mesh-export.user.js
npm test        # conversion tests against a trimmed real tessellatedfaces response
```

- `src/mesh.js` holds the pure conversion code, and the tests run against it.
- `src/userscript.js` holds the panel and the API calls.
- The build inlines both into a single file with no dependencies.

To let userscript managers update the script automatically, set `DOWNLOAD_URL` to the hosted raw file when you build:

```sh
DOWNLOAD_URL=https://raw.githubusercontent.com/<owner>/onshape-mesh-export/main/dist/onshape-mesh-export.user.js npm run build
```

To release, bump `version` in `package.json`, then rebuild.
