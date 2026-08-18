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
| `Ctrl+Z` | Undo stroke — or, while placing a line, remove the last point |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo stroke — or restore a removed line point |

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
  to surface** on (default) each segment is draped onto the mesh by marching the
  straight chord across the surface a step at a time, so the stripe follows
  curvature (no diving under faces) while staying visually direct — it does
  *not* take the long way around the way a dual-graph geodesic does, and it
  stays put on lathe/sliver meshes (cups, coolers) instead of sagging toward the
  triangle mid-heights. Turn it off for a straight 3D chord (e.g. to bridge a
  gap). On coarse or lathe meshes, whole-triangle painting spills the stripe
  into a band; tick **Crisp edges** to subdivide along the stroke for a clean,
  thin line (the app hints this when it detects it). Adjust *Line width* any
  time; Backspace or `Ctrl+Z` removes the last point and `Ctrl+Y` restores it,
  then commit with **Paint line** (active color) or **Block line** (fill
  barrier) — the latter is ideal for fencing off an emblem before filling it.
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
- **Mirror** (toolbar dropdown: Off / X / Y / Z) — symmetry painting. With an
  axis chosen, the direct tools (Brush, Blocker, Line, Smart Fill, Island Fill)
  also apply the stroke to the mirror-image location across the model-center
  plane, so you paint both sides at once — great for characters, vehicles, any
  bilateral model. A translucent blue plane shows the mirror; the status bar
  warns if the model isn't actually symmetric across that axis (so strokes
  won't land where you expect). Mirroring is geometric (nearest surface point
  at the reflected location), so it works regardless of how the mesh is
  triangulated, and undo covers both sides in one step. Decal/text projection
  aren't mirrored — use the tools above for symmetric detailing.

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

**Text decal:** type text, pick a font, optionally Bold/Italic, and **Create
text decal** — the text is rasterized in the active filament color and dropped
into the same overlay, so you position and **Apply** it exactly like an image
decal (with the same Detail/subdivision for crisp letters). The font list
starts with common families; the **⟳** button loads your actually-installed
system fonts via the browser's Local Font Access API (Chrome/Edge, asks
permission — falls back to the common list elsewhere). Best on flat and gently
curved faces today; per-glyph wrap around cylinders is planned.

**Curved text (per-glyph, "use surface"):** tick **Wrap on surface (per
glyph)**, set a **Height (mm)**, click **Place curved text…**, then click
**once** on the model to place the text and **Apply**. Like Orca's "use
surface / per glyph", the text lays along a **level baseline that wraps around
the model at constant height** — the advance direction is re-leveled to the
horizontal surface tangent at every step, so it stays flat and upright on a
cone or cylinder instead of drifting along a geodesic. Each glyph then projects
in its own surface tangent frame, undistorted. **Rotation** tilts the baseline
in the surface plane; click again to reposition; the preview updates live.
**Align** (Center/Left/Right) sets where the text sits relative to the click
point, and **Char gap** adds spacing between characters (Orca's char gap, in
mm). **Detail** subdivides along the glyph edges for crisp letters on
coarse/lathe meshes (like the decal Detail; above Off it rebuilds geometry and
clears undo). Esc or **Cancel** aborts. Thin-stroke text wants Finest/Ultra;
raise Height if letters come out chunky.

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

## Multiple objects (the shelf)

A file (or several) can hold more than one object, and MultiPaint keeps them
separate instead of merging them into one blob:

- **Multi-object 3MF** imports as one shelf entry per build item.
- **+ Append** (top bar) adds another file's objects to the current shelf, so
  you can assemble a plate from several STL/3MF files. Appended objects are
  auto-placed in free space beside the existing ones so nothing overlaps;
  **Auto-arrange** (Objects panel) re-packs everything into a tidy centered
  grid. The layout is written into the exported 3MF, so the slicer opens the
  plate already arranged.
- **Split into parts** (Objects panel) breaks the active object's disconnected
  shells into separate objects via the adjacency graph — e.g. a print that's
  actually several loose pieces.

The **Objects** panel lists them; click one to edit it (its paint, undo history
and mesh are shelved and swapped back when you return), double-click to rename,
duplicate, or remove. The filament palette is shared across all objects, so
slot 1 is the same filament everywhere. **Ghost other objects** (default on)
draws the shelved objects as translucent context at their plate positions —
relative to the object you're editing, which stays centered — so you can see
the whole plate while painting one piece. Switching objects keeps your camera,
so zoom out once and the layout stays in view as you work. Paint each object, then **Export 3MF** writes them
**all** as one multi-object file — each object a distinct, already-painted piece
at its original position — so the slicer opens the whole plate ready to go, no
Blender/slicer round-trip to split and re-paint.

## How the export works

The shelf is exported as one 3MF with **each object as its own build item**,
carrying per-triangle `paint_color` attributes — the exact mechanism Orca/Bambu
Studio use for their own painting tool (BambuStudio `TriangleSelector`
encoding: filament slot N → state N; `"4"`/`"8"`/`"0C"`/`"1C"`… per triangle).
Each object's geometry is written untouched at its original world position, so
the export can't introduce non-manifold edges or empty layers, and the objects
land where they belong on the plate. Unpainted (Base) faces print on slot 1.

## Architecture

- `src/viewer.js` — Three.js scene, STL parsing, geometry prep, BVH picking
- `src/painter.js` — per-triangle group model, adjacency, paint tools, undo,
  mirror, mesh-cache/connected-component helpers for the shelf
- `src/import3mf.js` — multi-object 3MF reader (paint + settings)
- `src/export3mf.js` — multi-object painted 3MF writer (no Three.js dependency)
- `src/main.js` — UI wiring and the object shelf (activate/snapshot/split)
