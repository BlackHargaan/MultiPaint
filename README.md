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

**Inside-out and badly wound STLs are repaired on import.** Some exporters
write models inside-out (every face pointing in) or with patches of faces wound
backwards; clicks would then land on the *far* side of the model, so brushes,
fills, decals and text hit the wrong place. MultiPaint checks every shell as it
loads: backwards patches are made consistent with their neighbors, and a shell
whose volume comes out negative is turned right side out. Correct models are
left untouched, flat or open surfaces are never flipped on a guess, and the
status bar says when a repair was made. Big meshes are checked in a background
worker.

### Install / offline

MultiPaint is a PWA: from a `build` + `preview` (or any hosted deploy) the
browser offers **⤓ Install** to run it in its own window, and a service worker
caches the app shell so it **works fully offline** — combined with the
IndexedDB autosave, you can install it, pull the network, and keep painting
with your project intact. (The large sample STLs are deliberately not cached.)

```sh
npm run build && npm run preview
```

## Desktop app (Windows / macOS / Linux)

MultiPaint also ships as a native desktop app (Electron), so you can run it
without a browser and it updates itself.

**Download:** grab the installer for your OS from the
[Releases page](https://github.com/BlackHargaan/MultiPaint/releases) — `.exe`
(Windows), `.dmg` (macOS), or `.AppImage` / `.deb` (Linux).

**Updating:** the top bar has a **⟳ Check for updates** button. It checks the
latest GitHub Release, downloads it in the background (showing progress), and
turns into **✓ Restart to update** when ready — one click installs it and
relaunches. It also checks quietly on startup, so you'll usually just see the
restart prompt when a new version is out. Your projects (IndexedDB autosave),
palette and saved setups carry across updates untouched.

### Building the desktop app yourself

```sh
npm run electron:dev   # run the desktop app against the dev server
                       #   (start `npm run dev` in another terminal first)
npm run dist           # build an installer for your current OS into release/
```

The web bundle is served inside the app over a private `app://` origin (not
`file://`), so IndexedDB, localStorage and the mesh Web Worker behave exactly
as they do in the browser; the PWA service worker is dropped from this build
since the app updates through GitHub Releases instead.

### Cutting a release (all three OSes)

Installers are built by CI (`.github/workflows/release.yml`) so each OS is
packaged on its own runner:

1. Bump `version` in `package.json` and commit.
2. Tag it and push: `git tag v1.2.3 && git push origin v1.2.3`.
3. The workflow builds Windows, macOS and Linux installers and uploads them to a
   **draft** GitHub Release.
4. Review the draft and click **Publish release** — every installed app's
   **Check for updates** button now offers it.

Notes: the version tag must match `package.json`'s `version`. Windows (NSIS) and
Linux (AppImage) auto-update out of the box; **macOS auto-update needs the app
to be code-signed** with an Apple Developer certificate — without signing, Mac
users update by downloading the new `.dmg`.

## Layout

- **Rail (left)** — every tool and feature is a button: the paint tools
  (Brush, Fill, Island, Blocker, Line), **Text** and **Image**, then **Colors**,
  **Objects** and **Check** (printability).
- **Settings panel (right)** — shows the settings for whatever you picked on the
  rail: brush size and Mirror for the paint tools, the text options for Text,
  and so on. Click the open item again (or ✕) to hide the panel and give the
  model the whole width.
- **Color bar (above the model)** — always visible: one chip per filament
  group, so switching paint color is one click from any tool (or keys `1`–`9`).
  **+** adds a color; **✎** opens the Colors panel to rename, pick from the
  filament library, or load a saved setup.

## Controls

| Input | Action |
|---|---|
| Left-drag | Paint with the active tool |
| Middle-drag | Rotate |
| Right-drag | Pan |
| Scroll | Zoom |
| One finger / stylus | Paint with the active tool |
| Two fingers | Orbit (drag) + zoom (pinch) |
| Pen pressure | Modulates brush size (harder = wider) |
| `B` / `F` / `I` / `X` / `L` | Brush / Smart Fill / Island Fill / Blocker / Line |
| `T` | Open / close the Text panel |
| `Esc` | Cancel the text pop-up or a wrap placement |
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
- **Mirror** (paint-tool settings: Off / X / Y / Z) — symmetry painting. With an
  axis chosen, the direct tools (Brush, Blocker, Line, Smart Fill, Island Fill)
  also apply the stroke to the mirror-image location across the model-center
  plane, so you paint both sides at once — great for characters, vehicles, any
  bilateral model. A translucent blue plane shows the mirror; the status bar
  warns if the model isn't actually symmetric across that axis (so strokes
  won't land where you expect). Mirroring is geometric (nearest surface point
  at the reflected location), so it works regardless of how the mesh is
  triangulated, and undo covers both sides in one step. Decal/text projection
  aren't mirrored — use the tools above for symmetric detailing.

## Filament groups & library

Each group is a color you paint with; its number is the filament slot it maps to
in the slicer (slot 1 is Base). Click a group to make it active, pick a color
with the swatch, double-click nothing — just type in its name field to rename.

- **Filament library** (📚 on any group, or **＋ From library**) — opens a
  browsable catalog of real-world filaments (Bambu Lab PLA Basic & Matte,
  Polymaker PolyTerra, Prusament, Hatchbox, and generics). Search by color,
  brand or material, filter by brand, and click a swatch to set that group's
  color **and** name in one go. ＋ From library adds a new group and opens the
  picker straight away. On-screen colors approximate each manufacturer's swatch
  for preview — your slicer still applies its own filament profile for the
  printed color and AMS assignment.
- **Custom filaments** — add your own with **＋ Custom** in the picker (name +
  color); they live under a **My filaments** section you can delete from, stored
  in your browser. **＋ From library** (below the groups) adds a new group and
  opens the picker straight away.
- **Recent** — filaments you've applied show up under a **Recent** chip, so
  reaching for a color you just used is one click.
- **Saved setups** — save your current groups as a named setup (e.g. your AMS
  loadout) and reload it on any project from the **Saved setups…** dropdown;
  the ✕ deletes the selected one. Setups are stored in your browser. Loading a
  setup never drops a slot that painted triangles still use — extra in-use
  groups are kept and the status bar says so.

The palette is shared across all objects on the shelf, so slot 1 is the same
filament everywhere, and it's saved with autosave and `.mpaint` projects.

## Printability check

FDM color printing paints one filament per region per layer, so a colored patch
only a nozzle-width wide won't reproduce — it smears or vanishes. The
**Printability** panel finds those before you export:

- **Min feature (mm)** — the smallest color patch that should still print as a
  distinct color (default 2 mm, roughly a few nozzle widths).
- **Check active object** — highlights, in red on top of the model, every
  painted patch narrower than that (width is estimated from each patch's area
  and the length of its color border, so it catches both thin slivers and tiny
  specks). The status line reports how many patches are below the limit and the
  thinnest one; if everything passes it says so.
- **Fix flagged** — absorbs every flagged patch into its dominant neighboring
  color in one undoable step, so you can clean up unprintable detail instantly.
- **Clear** — hides the highlight.

Only patches that border a *different* color count as features, so a whole
one-color object is never flagged — just the detail that's too fine to print.

## Text

**Text** on the rail opens the text settings. Type your text, pick a font
(the **⟳** button loads your installed system fonts via the browser's Local
Font Access API — Chrome/Edge, asks permission; elsewhere you get a common-font
list), optionally Bold/Italic, then choose an **Effect** and a **Placement**:

| Effect | What it makes |
|---|---|
| **Paint** | Flat color on the surface, in the active filament. Detail above Off cuts the mesh exactly along each letter's outline for smooth edges |
| **Raised** | Real 3D letters standing proud of the surface (Depth in mm), painted the active filament |
| **Engraved** | Letters cut into the surface (Depth in mm), painted the active filament |

| Placement | How you position it |
|---|---|
| **Drag on view (decal)** — default | **Add text** drops a **pop-up** over the model. Drag it, resize from the corner handle or scroll wheel, set **Rotation**, orbit the model behind it, then **Apply**. **Height (mm)** shows the text's real size on the model as you resize — or type a size to set it. Edits to the text, font or color update the pop-up live. |
| **Wrap around model (click)** | **Place on model…**, then click **once** on the model: the text lays along a **level baseline that wraps around the model at constant height** (Orca's "use surface / per glyph") — ideal for mugs and cylinders. **Rotation** tilts the baseline, **Align** sets where it sits relative to the click, **Char gap** adds letter spacing; click again to reposition. |

Either way each letter is placed **in its own surface tangent frame**, so text
follows curves without smearing. In the pop-up, each letter lands on the
surface directly under it; letters hanging off the model are skipped (the
status bar says how many).

**Raised / Engraved** build the letters as solids from the same glyph outlines
and fuse them to the model with a watertight boolean (the
[manifold](https://github.com/elalish/manifold) engine), so the result stays
printable and exports in the 3MF painted per-triangle. Before the boolean the
model is auto-repaired — welded, open holes filled, inside-out shells flipped —
so imperfect STLs (lathe meshes with an open bottom, flipped shells) work; a
genuinely non-manifold model may still be refused. The boolean runs in a
background worker so the UI doesn't freeze. Like Detail subdivision, embossing
rebuilds the mesh and clears the undo history. **Esc** or **Cancel** abandons a
placement.

## Image projection

Two ways to paint in 2D and apply in 3D (**Image** on the rail):

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
3. **Detail** — above Off, the mesh is **cut exactly along the decal's color
   outlines**. Each color region of the image gets a distance field (how far
   every pixel is from the nearest edge); every mesh vertex samples it, and
   wherever an edge's two ends land in different colors a vertex is inserted
   right where the outline crosses it and the triangles are split there. So
   painted edges follow the image's real shapes with sub-triangle precision —
   smooth curves and straight lines, no sawtooth of slivers — even on coarse
   or irregular organic meshes. Triangles near the outline are refined first
   (**Smooth / Smoother / Smoothest / Ultra** set how closely the cut follows
   tight curves: finer levels use shorter segments and more triangles;
   **Ultra** is for tiny or thin text), and huge lathe/revolve slivers (cups,
   coolers) are cut down to decal scale before that, so small decals can't
   slip between their corners. Cut points are shared by neighboring
   triangles, so the mesh stays watertight for export. Note: this rebuilds the
   mesh and clears the undo history; set Detail to **Off** for an undoable
   apply that paints whole triangles (fine on dense meshes, jagged on coarse
   ones).

**Snapshot round-trip (for AI-editing an exact view, WIP):**

1. Frame the model, then **Save view snapshot** — downloads a PNG and freezes
   the camera pose (you can keep orbiting/painting afterwards). The snapshot
   is rendered **flat-lit** (pure filament colors, no shading), so edits and
   re-import aren't polluted by shadows; it doubles as a coloring template.
2. Edit the PNG anywhere — Photoshop, GIMP, or ask an AI image model to
   recolor regions — using your filament colors from the color bar. Don't crop
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

## Saving your work

Two ways your work persists, separate from the slicer export:

- **Autosave / resume** — the whole project (every object's geometry, paint and
  blockers, the filament palette, and which object is active) is autosaved to
  the browser's IndexedDB as you work, and restored automatically the next time
  you open the app. Close the tab and come back — it's still there. Opening a
  new model (**Open**) starts over.
- **Save / Open project** — **Save project** writes a portable `.mpaint` file (a
  zip of the geometry and paint buffers) you can keep as a named snapshot or
  move to another machine; **Open project** restores it exactly, blockers and
  layout included. (This is a work file — use **Export 3MF** for the slicer.)

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
  mirror, printability report / auto-fix, mesh-cache/connected-component
  helpers for the shelf
- `src/filaments.js` — curated real-world filament catalog for the library picker
- `src/contour.js` — distance fields and exact contour cutting (smooth,
  watertight decal/text edges)
- `src/meshcore.js` — pure per-triangle caches (adjacency, normals, centroids)
  and `orientShells` (inside-out / mixed-winding repair on import)
- `src/meshcache.js` + `src/meshcache.worker.js` — build those caches in a Web
  Worker for big meshes (import and post-subdivision rebuild) so the UI doesn't
  freeze; synchronous fallback for small meshes / non-worker environments
- `src/emboss.js` + `src/emboss-core.js` + `src/emboss.worker.js` +
  `src/masktrace.js` — raised/engraved text geometry: trace glyph masks to
  polygons, repair the model (weld + hole-fill + orient), then run a watertight
  manifold-3d boolean in a Web Worker and paint the new faces the active group
- `src/import3mf.js` — multi-object 3MF reader (paint + settings)
- `src/export3mf.js` — multi-object painted 3MF writer (no Three.js dependency)
- `src/projectio.js` — project persistence (IndexedDB autosave + `.mpaint` files)
- `src/main.js` — UI wiring and the object shelf (activate/snapshot/split)
- `electron/main.cjs` + `electron/preload.cjs` — desktop shell: serves the
  built app over a secure `app://` origin and bridges the GitHub-Releases
  auto-updater (electron-updater) to the in-app Check-for-updates button
- `electron-builder.yml` + `.github/workflows/release.yml` — package the
  Windows / macOS / Linux installers and publish them on a version tag
