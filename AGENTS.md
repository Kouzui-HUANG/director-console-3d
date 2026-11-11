# Director Console 3D — Agent Guide

3D 導演台：在 Chrome 裡用低多邊形單色物件做預視（previs）、設定 30 秒內的物件與攝影機運動、多機位剪輯並輸出 MP4。
This guide is for AI agents. Everything a human can do in the UI is a JSON **command**; you use the same commands.

## Ways to operate

1. **MCP tools** (Claude Code / Claude Desktop): server `director3d` (see README). Tools: `get_guide`, `list_commands`, `list_asset_types`, `get_project`, `run_commands`, `describe_scene`, `view_camera`, `evaluate_scene`, `ground_height`, `check_scene`, `snapshot`, `plan_view`, `storyboard`, `export_video`, `get_export_status`, `list_projects`, `open_project`, `new_project`, `validate_project`. Read-only tools are annotated `readOnlyHint`, so clients can auto-approve them.
2. **HTTP** (companion server at `http://127.0.0.1:5178`): `POST /api/rpc` with header `x-director-token: <.director3d/token>` and body `{"method":"run","params":{"commands":[...]}}`. Methods mirror `window.director`.
3. **In the page**: `window.director.run([...])`, `.describe()`, `.snapshot()`, … (browser automation, DevTools).
4. **Edit files**: `projects/<id>.json` (schema: `schema/project.schema.json`). The open tab reloads the file live as one undoable step and reports validation errors.

Rendering tools (snapshot, plan_view, storyboard, export) need the app open in a browser tab. The MCP server starts the companion server and opens Chrome automatically when needed.

## Conventions (important)

- Units: **meters, degrees, seconds**; focal length in **mm**. Max duration 30 s.
- Axes: **Y is up**, ground is y = 0. **+X = east (right), −Z = north (away from the default camera), +Z = south.**
- `rotation` = Euler degrees `[x, y, z]`, order **YXZ**. `y` = yaw: **positive turns left** (counter-clockwise seen from above).
- Objects (people, cars, chairs…) **face +Z at yaw 0**. Yaw 90 → facing east (+X), 180 → north, −90 → west.
- Cameras **look toward −Z at rotation 0**. For cameras rotation = `[tilt, pan, roll]`: tilt + = look up, pan + = turn left.
- Prefer `lookAt` / `object.face` / `camera.frame` over computing angles yourself.
- `position` of most objects is their base point on the ground (characters: between the feet; sitting: under the pelvis).
- ids: letters/digits/`_`/`-`, start with a letter, stable forever (`hero`, `camA`). `name` is free text (Chinese OK).
- Points on the ground may be given as `[x, z]`; vectors also accept `{x, y, z}`; colors accept `#rrggbb` or names (`red`, `gray`, `藍`).

## Project document

```json
{
  "format": "director3d.project", "version": 1, "id": "p_ab12cd34", "name": "街頭對話",
  "settings": { "duration": 12, "fps": 24, "aspect": "16:9", "resolution": [1920, 1080],
                "environment": { "preset": "day", "sunAzimuth": 135, "sunElevation": 50, "fog": true, "fogDensity": 0.2, "shadows": false } },
  "objects": [
    { "id": "hero", "type": "male", "name": "主角", "color": "#3b6fd8", "position": [0, 0, 0], "rotation": [0, 180, 0],
      "scale": [1, 1, 1], "visible": true, "locked": false, "params": { "height": 1.75, "build": "average", "pose": "stand" },
      "tracks": { "position": { "keys": [ { "t": 0, "v": [0, 0, 0], "ease": "linear" }, { "t": 3, "v": [0, 0, -4] } ] } } },
    { "id": "camA", "type": "camera", "position": [0, 1.6, 6], "rotation": [0, 0, 0],
      "camera": { "rig": "tripod", "lens": "standard", "focalLength": 35, "sensor": "super35",
                  "lookAt": { "target": "hero", "aim": "head", "offset": [0, 0, 0], "point": null }, "follow": null,
                  "fisheye": { "fov": 180, "mapping": "equidistant", "circular": false },
                  "shake": { "preset": "none", "amount": 0.5, "seed": 1 } } }
  ],
  "cuts": [ { "t": 0, "camera": "camA" }, { "t": 6, "camera": "camB" } ],
  "markers": [ { "t": 3, "label": "主角回頭" } ]
}
```

## Animation model

- A property is **static** unless its track has keyframes. Before the first key it holds the first value; after the last key, the last value.
- `ease` on a key controls the motion **from that key to the next**: `linear`, `in`, `out`, `inOut` (default), `hold` (jump at the next key).
- Position tracks can be `"path": "smooth"` (curve through the points).
- Enum / boolean properties (pose, visible) always switch instantly (hold).
- `object.update` on an **animated** property writes a keyframe at `t` (default: the playhead) instead of the static value. Pass `key: true` to start animating a static property.
- Animatable paths: `position`, `rotation`, `scale`, `visible`, `color`, `camera.focalLength`, `camera.fisheye.fov`, `camera.shake.amount`, and params marked animatable (`params.pose` for characters, `params.open` for doors).
- Characters are **static mannequins**: they move as a whole; switch `params.pose` (stand, walk, run, sit, talk, wave, point, phone, armsCrossed, handsOnHips, raiseHand, crouch, lie) with keys. `object.moveTo` / `object.followPath` do this for you (walk pose while moving, turn toward travel direction).

## Cameras

- `lens`: `standard` (rectilinear, uses `focalLength` + `sensor`), `fisheye` (`fisheye.fov` 60–360°, mapping `equidistant|equisolid|stereographic|orthographic`, `circular`), `panorama` (360° equirectangular; use aspect `2:1`).
- `sensor`: `fullFrame`, `super35` (default), `apsc`, `mft`, `oneInch` (drones), `phone`. The sensor's long side maps to the frame's long side; FOV follows real lens math.
- `rig`: `tripod`, `handheld` (adds handheld shake), `dolly`, `crane`, `drone` (1" sensor, ≈24 mm equivalent, gentle drift).
- `lookAt`: `{target, aim: auto|head|chest|center|feet, offset}` or `{point:[x,y,z]}` — overrides tilt/pan; roll (rotation z) still applies.
- `follow`: `{target, offset:[x,y,z], space: world|local, lag: seconds}` — position follows the target.
- `shake`: `preset` none|handheld|walk|drone|vehicle|earthquake, `amount` 0–2 (animatable), deterministic per `seed`.
- Multi-camera editing: `cut.set {t, camera}` — from time t the program uses that camera (hard cuts). Without cuts the first camera is used.

## Commands

Send a list: `[{"cmd": "object.add", "args": {...}}, ...]`. A list is **atomic** (all or nothing) and one undo step. Use `"$0"` (or `"$0.id"`) to refer to the result of command 0 in the same list.

| Command | What it does |
|---|---|
| `object.add` | Add an object `{type, id?, name?, color?, position?, rotation?, scale?, params?, camera?}` → `{id}` |
| `object.update` | Change fields; animated props get a key at `t`; `key:true` forces a key; `camera:{...}` deep-merges |
| `object.remove` | Delete `{id}` or `{ids}` |
| `object.duplicate` | Copy with offset |
| `object.moveTo` | Animate to a point (walk/run pose, turn toward travel) `{id, to, start?, duration?|speed?, ease?, gait?}` |
| `object.followPath` | Through waypoints at constant speed (smooth) `{id, points, start?, speed?|duration?}` |
| `object.face` | Face a target/point or set yaw; for cameras aims pan/tilt |
| `object.place` | Place relative to another object using real footprints: `{id, on}` (on top), `{id, relativeTo, side?: front\|back\|left\|right\|north\|south\|east\|west, distance?}` (gap, default 0.3 m; characters face the target), `{id, sitOn}` (chair/sofa/bench/bed/car, pose sit). `object.add` takes the same as `place: {...}` |
| `key.set` / `key.remove` / `key.move` / `key.clear` | Edit keyframes `{id, prop, t, v?, ease?}` |
| `camera.frame` | Standard framing `{camera, target, shot: ECU|CU|MCU|MS|MLS|FS|LS|ELS, angle?: eye|high|low|overhead|worm|dutch, side?: front|frontLeft|left|backLeft|back|backRight|right|frontRight, over?, shoulder?, focalLength?, keepPosition?, t?}` |
| `camera.move` | Move preset as keys `{camera, preset, start?, duration?, amount?, target?, ease?}` |
| `cut.set` / `cut.remove` / `cut.clear` | Edit decision list |
| `marker.set` / `marker.remove` | Timeline beats |
| `project.update` | Name, notes, `settings` (duration, fps, aspect, resolutionTier, resolution, environment) |
| `project.replace` | Replace the whole scene with a project JSON (validated) |
| `ui.seek` / `ui.select` | Playhead / selection (not undoable) |
| `history.undo` / `history.redo` | `{steps?}` — send on their own |

`camera.move` presets: dollyIn, dollyOut, truckLeft, truckRight, pedestalUp, pedestalDown, craneUp, craneDown, panLeft, panRight, tiltUp, tiltDown, rollLeft, rollRight, orbitLeft, orbitRight, zoomIn, zoomOut, dollyZoomIn, dollyZoomOut, droneRise, droneFlyover, droneOrbit, topDownRise. Pan/tilt need a camera **without** lookAt.

Full JSON Schemas: `list_commands` (MCP) / `director.listCommands()`. Errors come back as `{index, cmd, code, message, hint}` — the hint usually tells you the fix (valid ids, valid types, an example). A failed batch returns `error` (the first) **and `errors` (every problem in the batch)**: failing commands are skipped and the rest still checked; commands that use the result or id of a failed one report `DEPENDS_ON_FAILED`. Fix them all, then resend (or `dryRun: true` to check first).

## Object types

Characters: `male`, `female`, `child` (height, build, pose; female: hair, outfit), `passerby` (seed, gender, pose), `crowd` (count, width, depth, pose mix, facing — one cheap mesh).
Terrain: `ground` (size), `hills` (size, height, scale, flatRadius, seed — flat in the middle), `water`, `road` (along Z).
Architecture: `wall` (length along X, height, thickness, openings), `room` (width X, depth Z, height, doors/windows on north|south|east|west walls, centered on its position), `building` (floors, floorHeight, roof flat|gable, windows), `house`, `cityBlock` (grid of random buildings, seed), `stairs` (ascending toward −Z), `pillar`.
Props: `box`, `sphere`, `cylinder`, `cone`, `plane`, `table`, `chair` (faces +Z; seat a character with `object.place {id, sitOn: "chair1"}`), `sofa`, `bed`, `desk`, `door` (open angle animatable), `car` (front +Z; sedan|suv|van|truck), `tree`, `bush`, `streetLight`, `bench`.
Helpers (editor only, never rendered by shot cameras): `camera`, `target` (aim point), `mark` (floor mark).
Exact params with ranges and defaults: `list_asset_types {type: "male,chair"}` (MCP) / `director.assetTypes()`.

## Work loop for agents

1. `describe_scene` to learn the current state (ids, positions, what cameras see). `get_project` gives the raw JSON — pass `ids` / `fields` (`settings`, `objects`, `cuts`, `markers`, `notes`) to fetch only what you need. `evaluate_scene` gives exact resolved transforms at a time; `ground_height` gives terrain y on hills.
2. `run_commands` with a small atomic batch.
3. Verify: `describe_scene` (text, includes per-camera "sees: hero MS center 18% of frame"), `view_camera` (frame boxes, shot size, occlusion), and the images:
   - `plan_view` — top-down floor plan (north up): ids, facing arrows, camera field-of-view wedges (LIVE red), motion paths with key times, metric grid. Best for blocking, camera placement and the 180° line. `area: [minX, minZ, maxX, maxZ]` zooms.
   - `snapshot {labels: true}` — the camera image with each object's id, frame box, shot size and "% hidden"; scenery is listed along the bottom edge.
   - `snapshot {cameras: "all", labels: true}` — every camera at that time side by side (LIVE outlined red), to compare coverage.
   - `storyboard` (optionally `labels: true`) to check the whole edit.
4. Fix and repeat. `history.undo` reverts a batch. After every successful batch, `run_commands` returns `checks.new` — scene problems that batch introduced (overlaps, floating objects, crossed 180° line, jump cuts…) — and `checks.resolved`. Fix new warnings before moving on.
5. Before exporting, run `check_scene` (whole timeline): OVERLAP, FLOATING, BELOW_GROUND, CAMERA_INSIDE, CAMERA_UNDERGROUND, EMPTY_SHOT (note), SUBJECT_HIDDEN, CROSSED_LINE, JUMP_CUT, SHORT_SHOT, SAME_CAMERA_CUT, CUT_AFTER_END, KEYS_AFTER_END. Each issue has ids, a time range and a hint with the fix. `describe_scene` ends with a one-line summary when there are issues.
6. `export_video` when the shot works (returns a path in `exports/`).

## Recipes

Dialogue with over-the-shoulder coverage:
```json
[
 {"cmd":"object.add","args":{"type":"male","id":"a","position":[0,0,1.2],"rotation":[0,180,0]}},
 {"cmd":"object.add","args":{"type":"female","id":"b","position":[0,0,-1.2]}},
 {"cmd":"object.add","args":{"type":"camera","id":"wide"}},
 {"cmd":"camera.frame","args":{"camera":"wide","target":"b","shot":"MLS","side":"frontRight","focalLength":28}},
 {"cmd":"object.add","args":{"type":"camera","id":"otsA"}},
 {"cmd":"camera.frame","args":{"camera":"otsA","target":"b","shot":"MCU","over":"a","shoulder":"right"}},
 {"cmd":"object.add","args":{"type":"camera","id":"otsB"}},
 {"cmd":"camera.frame","args":{"camera":"otsB","target":"a","shot":"MCU","over":"b","shoulder":"left"}},
 {"cmd":"cut.set","args":{"t":0,"camera":"wide"}},
 {"cmd":"cut.set","args":{"t":3,"camera":"otsA"}},
 {"cmd":"cut.set","args":{"t":6,"camera":"otsB"}}
]
```

Walk and track:
```json
[
 {"cmd":"object.followPath","args":{"id":"hero","points":[[2,-3],[0,-8],[-3,-12]],"start":0,"speed":1.4}},
 {"cmd":"object.add","args":{"type":"camera","id":"track","camera":{"rig":"handheld","follow":{"target":"hero","offset":[1.5,1.6,3],"lag":0.2},"lookAt":{"target":"hero","aim":"head"}}}}
]
```

Drone reveal + orbit: `{"cmd":"object.add","args":{"type":"camera","id":"drone","position":[0,8,40],"camera":{"rig":"drone","lookAt":{"target":"hero"}}}}` then `{"cmd":"camera.move","args":{"camera":"drone","preset":"droneRise","start":0,"duration":6,"amount":40}}` and `{"cmd":"camera.move","args":{"camera":"drone","preset":"droneOrbit","start":6,"duration":8,"amount":120}}`.

Dolly zoom (vertigo): frame the subject with lookAt, then `{"cmd":"camera.move","args":{"camera":"camA","preset":"dollyZoomIn","start":1,"duration":4,"amount":0.5}}`.

360° shot: `project.update {settings:{aspect:"2:1", resolutionTier:"4k"}}` and a camera with `camera:{lens:"panorama"}`. (Players need spherical metadata injected separately to treat the MP4 as 360.)

## Gotchas

- Rotation units are degrees, not radians. Yaw positive turns **left**.
- Cameras with `lookAt` ignore their own tilt/pan; use orbit/truck/dolly moves, or set `lookAt:null` first.
- Cameras with `follow` ignore their own position.
- Keys after `settings.duration` are kept but never reached — extend the duration.
- `project.update` with `aspect` recomputes `resolution` (even numbers) for the current tier.
- Snapshot images default to 768 px JPEG; ask for `width` to get more.
