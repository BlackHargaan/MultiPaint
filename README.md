# MultiPaint

Paint 3D models for multicolor printing with better tools than the slicer
gives you, then export a 3MF that imports into a slicer as
one object with one part per color — with filament slots already assigned.

Created after purchasing the Snapmaker U1 and needing better ways to paint models that weren't designed with that in mind. 

## Run it

```sh
npm install
npm run dev
```

Open the printed URL, then open or drag-and-drop an STL **or 3MF**.
A sample `public/test-cube.stl` is served at `/test-cube.stl`.

Re-opening a MultiPaint export (either mode) restores the painting, so
exports double as project save files. Bambu/Orca-painted 3MFs import too
(per-triangle paint and part/filament assignments; project filament colors
are picked up when present). Your filament palette (names + colors) is
remembered between sessions automatically.

## Controls

| Input | Action |
|---|---|
| Left-drag | Paint with the active tool |
| Middle-drag | Rotate |
| Right-drag | Pan |
| Scroll | Zoom |
| `B` / `F` / `I` / `X` / `L` | Brush / Smart Fill / Island Fill / Blocker / Line |
| Alt+drag | Erase (paint → base, blockers → removed) |
| `Backspace` | Remove last line point (Line tool) |
| `[` / `]` | Brush size |
| `+` / `-` | Grow / shrink the active group's region by one ring |
| `1`–`9` | Select filament group |
| `Home` / Numpad `0` | Home (three-quarter) view |
| Numpad `1`/`3`/`7` | Front / Right / Top view (`Ctrl` for Back / Left / Bottom) |
| Numpad `5` | Toggle orthographic / perspective |
| `Ctrl+Z` | Undo stroke |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo stroke |

View preset buttons (Front/Back/Left/Right/Top/Bottom + Ortho) sit in the
top-left corner of the viewport. After saving a snapshot, **↩ Return to
snapshot view** moves the camera back to exactly where the snapshot was
taken — handy for checking the projection result or re-shooting.

## Tools

- **Brush** — paints triangles within a radius, walking the surface from the
  hit point so it never bleeds through thin walls onto the far side. Alt-drag
  erases back to the base color.
- **Line** — click to drop points connected along the surface (previewed as a
  translucent capsule chain at true width, like a Blender spline). With **Cling
  to surface** on (default) each segment is a geodesic path draped over the
  mesh between the two points, so the stripe follows curvature instead of
  cutting a straight chord under the model — the fix for lines that used to
  dive under faces on curved regions when the points were far apart. Turn it
  off for a straight 3D chord (e.g. to bridge a gap). Adjust *Line width* any
  time, Backspace removes the last point, then commit with **Paint line**
  (active color) or **Block line** (fill barrier) — the latter is ideal for
  fencing off an emblem before filling it.
- **Smart Fill** — scrubbable priority flood. Click to fill, then *keep the
  button held and drag right/left* to grow or shrink the fill in real time.
  The fill expands across the cheapest edges first: flat surface is free,
  sharp edges cost their angle, and concave valleys (where embossed emblems
  meet the surface) cost 2.5× — so it hugs feature boundaries even when
  they're smoothly filleted. Release to commit; the slider sets the starting
  reach.
- **Island Fill** — fills an entire connected shell, stopping at blockers.
- **Blocker** — paints barriers (purple tint) that no fill can cross; trace a
  rough line around a feature, then fill inside it. Alt-drag erases; *Clear
  blockers* removes all. Blockers are a painting aid only — they don't affect
  export.
- **Grow / Shrink** — expand or contract the active group's painted region by
  one triangle ring; shrink hands triangles back to the neighboring group.
- **Through** (checkbox) — the brush/blocker paints everything inside the
  brush sphere including hidden back sides of thin walls, so painting over a
  region destroys what was underneath instead of leaving residue.
- **Crisp edges** (checkbox, brush/blocker/line) — when the stroke ends, the
  mesh is subdivided along the stroke boundary (same conforming refinement as
  the decal Detail option) and the stroke is re-applied precisely, so brush
  dots are round and lines are straight even on a 2-triangle cube face.
  Notes: rebuilds geometry per stroke (clears undo history), refined strokes
  paint through thin walls like the Through mode, and Alt-erase strokes skip
  refinement.
- **Despeckle** — absorbs tiny leftover paint islands (hidden residue from
  painting over a region) into their surrounding color.

## Image projection

Two ways to paint in 2D and apply in 3D (sidebar, bottom section):

**Decal overlay (interactive, Primed3D-style, Recommended):** 

1. **Load decal image…** — the image floats semi-transparent over the
   viewport. Drag to position, corner handle / scroll wheel / Scale slider to
   resize, Rotation slider to rotate, and orbit the model behind it.
   **Remove background** cuts away the image's solid background (flood-filled
   from the borders) so only the subject projects — the overlay previews the
   cutout live. *BG tolerance* controls how aggressive the match is;
   *Edge trim* grows (+) or shrinks (−) the removed area by pixels to clean
   halo fringes. Non-destructive: adjust or toggle off anytime before Apply.
2. **Apply decal** — every triangle visible under the overlay (front-facing,
   not occluded, checked by raycast) samples its pixel, snaps to the nearest
   filament color, and gets assigned. Transparent PNG pixels are skipped, so
   logo decals with alpha land exactly as cut. One undoable stroke.
3. **Detail** — with subdivision on (default: 3 rounds), triangles that
   straddle the decal's color boundaries are split before painting, so edges
   come out crisp even on coarse meshes (a plain cube face gets a round
   circle, not two half-face blobs). **Ultra (5 rounds)** targets small text:
   the pre-cut size and the refinement floor both scale with the Detail
   level, so letter strokes can't slip between sample points — expect it to
   take noticeably longer than the other levels. Refinement is two-phase: oversized
   triangles overlapping the decal are first cut down to decal scale — so
   lathe/revolve topology (full-height sliver triangles around a cylinder,
   e.g. cups and coolers) works without remeshing — then color boundaries
   are refined. Uses conforming red-green refinement —
   neighbors stay stitched, no T-junctions, the mesh stays watertight for
   export. Note: subdividing rebuilds the mesh and clears the undo history;
   set Detail to "Off" for a normal undoable apply.

**Snapshot round-trip (for AI-editing an exact view, WIP):**

1. Frame the model, then **Save view snapshot** — downloads a PNG and freezes
   the camera pose (you can keep orbiting/painting afterwards). The snapshot
   is rendered **flat-lit** (pure filament colors, no shading), so edits and
   re-import aren't polluted by shadows; it doubles as a coloring template.
2. Edit the PNG anywhere — Photoshop, GIMP, or ask an AI image model to
   recolor regions — using your filament colors from the sidebar. Don't crop
   or rotate; resizing is fine.
3. **Import edited image** — same projection rules as the decal, applied from
   the saved pose.

Options: **Recover dark colors** (default off) — brightens dark image areas
so a saturated color rendered too dark still reads as that color. Leave it
off for logos with black regions: on, it can turn compression noise in dark
areas into colored speckle. **Create colors from image** (default on) — filament groups are
created automatically from the image's dominant colors (anti-aliased edge
blends are filtered out; colors near an existing group reuse it; capped at
the 16-slot slicer limit). Turn it off to force the projection onto your
existing palette only. **Color tolerance** — how close a pixel must be to a
filament color to count when auto-create is off (raise for JPEG artifacts /
AI output). **Only changed pixels** —
apply only where the image differs from the snapshot; turn OFF for
AI-regenerated images, where every pixel shifts slightly (the tolerance
cutoff then protects unedited shaded areas).

Repeat from 2–3 angles to cover the whole model; grazing and hidden
triangles are deliberately left for the next view.

## How the export works

**Painted model (default, recommended):** the mesh is exported as a single
untouched solid with per-triangle `paint_color` attributes — the exact
mechanism Orca/Bambu Studio use for their own painting tool (BambuStudio
`TriangleSelector` encoding: filament slot N → state N; `"4"`/`"8"`/`"0C"`/
`"1C"`… per triangle). Geometry is bit-identical to the input model, so the
export cannot introduce non-manifold edges or empty layers. The model imports
as one object, already painted; unpainted (Base) faces print on slot 1.

**Separate parts:** each filament group's triangles become a separate mesh
part inside one object, with `Metadata/model_settings.config` pre-assigning
each part's filament slot. Use this only when your groups are genuinely
separate closed shells (e.g. a figure and its base); for painted-on surface
regions the parts are open zero-thickness patches, which slicers have to
repair — producing exactly the empty layers / non-manifold edges the painted
mode avoids.

## Architecture

- `src/viewer.js` — Three.js scene, STL loading, BVH-accelerated picking
- `src/painter.js` — per-triangle group model, adjacency, paint tools, undo
- `src/export3mf.js` — multi-part 3MF writer (no Three.js dependency)
- `src/main.js` — UI wiring
