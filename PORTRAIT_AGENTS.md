# Portrait Studio (人像工作室) — Agent Guide

Parametric, realistic **white sculpture portraits** (head, bust, half figure, full figure) built on the MakeHuman CC0 base mesh with our own engine. You describe a person with **semantic parameters** (`face.nose.bridgeHeight`, `body.heightCm` …), **traits** (Chinese descriptions such as 丹鳳眼, 高鼻樑) and **presets**; every change is a JSON **command**, exactly what the UI uses. The result is a static statue you can render from any angle. Eyebrows are sculpted as a relief on the skin (with engraved strands); no hair yet (bald heads until a later phase), no materials or colors.

## Ways to operate

1. **MCP tools** (server `portrait3d`, see `.mcp.json`): `portrait_guide`, `portrait_list_params`, `portrait_list_presets`, `portrait_list_commands`, `portrait_list`, `portrait_new`, `portrait_open`, `portrait_get`, `portrait_run`, `portrait_measure`, `portrait_check`, `portrait_render`, `portrait_export`, `portrait_validate`, and for reference photos `portrait_add_reference`, `portrait_references`, `portrait_compare`, `portrait_fit`. Read-only tools are annotated `readOnlyHint`.
2. **HTTP** (companion server `http://127.0.0.1:5178`): `POST /api/portrait-rpc` with header `x-director-token: <.director3d/token>` and body `{"method": "run", "params": {"portraitId": "pt_…", "commands": [...]}}`. Methods: `help, listParams, listPresets, listCommands, list, create, open, get, run, measure, check, render, exportPng, save, references, addReference, removeReference, compare, fit`.
3. **In the page** (`/portrait`): `window.portrait.run({commands})`, `.measure()`, `.render({views})`, … (`window.portrait.help()`).
4. **Edit files**: `portraits/<id>.json` (schema: `schema/portrait.schema.json`). An open studio tab reloads the file live as one undoable step; unknown parameters are dropped with a "did you mean" warning (`portrait_validate`).

`portrait_render`, `portrait_export` and the photo tools need the studio open in a browser tab — the MCP server starts the companion server and opens Chrome when needed. Everything else also works **without a tab**, directly on the files (`"headless": true` in results). When a tab is open, requests go to it, so the person sees your changes live and can undo them.

## Conventions (important)

- **Local shape parameters: −1 … +1**, 0 = unchanged; ±1 ≈ the realistic extreme of real people. Values up to the parameter's `limit` (usually ±2) are allowed as **exaggeration**; you get an `EXAGGERATED` note, and values beyond the limit are clamped with a warning.
- **One-sided parameters: 0 … 1** — face-shape blends (`head.shape.*`, realistic ≤ 0.6), expressions (`expr.*`), `face.cheek.nasolabial`.
- **Macros**: `base.sex` 0 = female … 1 = male (continuous); `base.age` in years; ethnicity is a mix of `base.eastAsian`, `base.european`, `base.african` (normalized; none given = an even mix); `base.weight`, `base.muscle`, `body.proportions`, `body.breastSize`, `body.breastFirmness` are −1 … +1 with 0 = average.
- **Absolute values**: `body.heightCm` (cm) and `body.headsTall` (body height ÷ head height, realistic 6–9). Omitted or `null` = automatic. When set they are met exactly: height through MakeHuman's height targets (plus a uniform scale beyond their range), heads-tall through a head scale — and both stay put when you change sex, ethnicity or anything else.
- **Left / right = the figure's own left / right.** Paired features (eyes, ears, cheeks) always move together; use the `asym.*` group for natural asymmetry.
- **Pose and gaze in degrees**: `pose.headYaw` + = turns toward the figure's left; `pose.headPitch` + = chin up; `pose.headRoll` + = tilts toward the figure's left shoulder; `pose.arms` = upper arms from vertical (default 10 = relaxed; 40 ≈ A-pose); `pose.elbow` flexion. `face.eyes.gazeYaw` / `gazePitch` turn the eyes relative to the head.
- **Framing** (`portrait.update {framing: {type}}`): `head` (head and neck), `bust` (default: mid-chest, arms cut obliquely below the deltoids), `half` (waist up), `full`.
- Measurements are in **mm** (`canthalTilt` in degrees). Meshes: mm, +Y up, soles at y = 0, the figure faces +Z.
- ids look like `pt_k3v9x2ab` and never change; `name` is free text (Chinese OK).

## Portrait document

```json
{
  "format": "director3d.portrait", "version": 1, "id": "pt_k3v9x2ab", "name": "林小姐・胸像",
  "preset": "female-eastAsian",
  "params": {
    "base.sex": 0, "base.age": 26, "base.eastAsian": 1, "body.heightCm": 162,
    "head.shape.oval": 0.4, "face.eyes.tilt": 0.6, "face.eyes.lidCrease": -0.5,
    "face.nose.bridgeHeight": 0.3, "face.mouth.upperLip": -0.4, "expr.smile": 0.3, "pose.headYaw": 8
  },
  "framing": { "type": "bust", "cut": "flat", "pedestal": "none", "heightMm": null },
  "references": [], "notes": "", "revision": 12,
  "createdAt": "2026-11-15T10:00:00Z", "updatedAt": "2026-11-15T10:42:00Z"
}
```

Only parameters that differ from their defaults are stored. `cut`, `pedestal` and `heightMm` are reserved for later phases.

## Commands

Send a list: `[{"cmd": "portrait.set", "args": {...}}, ...]`. A list is **atomic** (all or nothing) and one undo step. On failure every problem is listed (`errors`, each with `index`, `code`, `message`, `hint`) — fix them all, then resend, or use `dryRun: true` first.

| Command | What it does |
|---|---|
| `portrait.set` | `{params: {"face.eyes.spacing": 0.6, "body.heightCm": 168}}` — set values; `null` clears one (absolute ones become automatic) |
| `portrait.reset` | `{keys?, groups?}` — back to defaults; `{}` resets everything |
| `portrait.applyPreset` | `{preset: "male-european"}` or `{params: {...}}`, optional `groups` to take only some parts (e.g. the face from one preset, keep the body) |
| `portrait.applyTraits` | `{traits: ["鵝蛋臉", "丹鳳眼"], amount?: 0…1.5 (1 = as written), mode?: "set" \| "add"}` |
| `portrait.mix` | `{sources: [{preset, weight}, {params, weight}], groups?}` — weighted blend |
| `portrait.update` | `{name?, notes?, framing?: {type}}` |
| `portrait.neutralize` | remove the expression (all `expr.*`), keep the likeness |
| `portrait.randomize` | `{seed?, amount?, groups?}` — deterministic variation of the face (inspiration, tests) |
| `history.undo` / `history.redo` | `{steps?}` — send on their own |

Full schemas: `portrait_list_commands {name}`.

## Parameters

159 parameters in 14 groups — `portrait_list_params` lists them, `portrait_list_params {group: "nose"}` gives full specs.

- **base** — sex, age, ethnicity mix, weight, muscle.
- **head** — size, width, length, depth, back of the head, facial fat, facial age, forehead height and slope, temples, **skull width above the brows** (`head.craniumWidth`: our own deformation — widens / narrows only the cranium from the upper forehead up, face and ears untouched; +1 ≈ 12 % wider, −1 ≈ 7 % narrower), face-shape blends (`head.shape.oval / round / square / long / triangle / heart / diamond`).
- **brow** — the skin and bone: brow ridge, brow height, brow tilt (+ = upswept 劍眉, − = 八字眉); the eyebrows themselves (a relief that rides on the skin, so it follows every shape, expression and head turn): `relief` (0 = no brows, a classical plaster look; 1 = standard), `density`, `thickness`, `length`, `arch` (− = straight 一字眉), `peak` (position of the arch), `gap` (between the inner ends), `head` (inner end: − fades in, + blunt), `texture` (0 = smooth mass … 1 = clear strands; strands are engraved by the renderer, the mesh carries the mass). 0 = the average brow for the sex and age (men thicker, straighter, lower).
- **eyes** — size, fissure length (`width`), opening (and inner / outer), spacing, height, tilt (+ = outer corner up), inner corner, double eyelid (`lidCrease`: − monolid … + deep crease), fold height and direction, epicanthus, bags, gaze.
- **nose** — length, width, projection, position, bridge height (山根), bridge width, alar width, flare, nostrils, tip width / roundness / lift, dorsum curve, hump, columella, base.
- **mouth** — width, position, protrusion, upper / lower lip thickness and fullness, cupid's bow, tubercle, corners (+ up), philtrum, dimples.
- **cheek** — cheekbones (prominence, height), fullness, apples, nasolabial folds.
- **chin** — chin length, width, projection, prognathism, cleft, double chin, jaw angle, jaw width.
- **ears** — size, length, position, tilt, protrusion, helix, lobe, shape.
- **neck** — length, thickness.
- **body** — `heightCm`, `headsTall`, proportions, shoulder width and slope, torso, chest, pecs, lats, breasts (size, firmness, position, spacing, shape), bust / waist / hips, hip width, belly, buttocks, arms, legs, hands, feet.
- **expr** — `smile`, `mouthOpen`, `browRaise`, `frown`, `squint` (0…1, combinable).
- **pose** — head yaw / pitch / roll, arms, elbows.
- **asym** — left/right differences: eye height and size, brow height, ear height, cheek height, nose and mouth shift, mouth corner.

## Presets and traits

- Presets: `neutral`, `female-eastAsian`, `male-eastAsian`, `female-european`, `male-european` (with average adult heights 160 / 172 / 165 / 178 cm).
- Traits (`portrait_list_presets`, `recipes: true` shows their parameters), grouped as 臉型, 眼, 眉, 鼻, 嘴, 下巴, 其他, 身材 — for example 鵝蛋臉 圓臉 方臉(國字臉) 瓜子臉 長臉 菱形臉 心形臉 小臉; 丹鳳眼 杏眼 桃花眼 細長眼 大眼睛 單眼皮 內雙 雙眼皮 深邃眼窩 下垂眼 上揚眼 眼距寬; 劍眉 八字眉 一字眉 柳葉眉 挑眉 濃眉 淡眉 粗眉 細眉 短眉 長眉 眉距寬 眉距近 眉頭方 高眉骨 不雕眉毛 眉毛平滑; 高鼻樑 塌鼻 鷹勾鼻 蒜頭鼻 朝天鼻 駝峰鼻 小巧鼻; 厚唇 薄唇 櫻桃小嘴 M 唇 微笑唇 嘴角下垂 酒窩; 戽斗 小下巴 方下巴 尖下巴 美人溝 雙下巴; 高顴骨 蘋果肌 法令紋 招風耳 高額頭; 寬肩 溜肩 沙漏身材 梨形身材 運動員體型 纖瘦 豐滿 啤酒肚 長腿.
- Trait mode `set` (default) sets those parameters (a later trait wins on the same parameter); `add` adds to the current values.

## Measurements and checks

`portrait_measure` returns:
- `measures` (mm) — height, head height and heads-tall, head width / length, face height / width, jaw width, mid / lower face, pupil distance, inner / outer eye-corner distance, eye fissure length and opening, canthal tilt (°), nose width / length / projection, mouth width, philtrum + upper lip, lip thickness, chin height and projection, ear length and position, lip gap.
- `ratios` — face width ÷ height, mid ÷ lower face, eye length ÷ eye spacing, nose width ÷ eye spacing, mouth ÷ nose width, jaw ÷ face width.
- `z` — each measure compared with an **average person of the same sex, ethnicity, age and height**, in typical standard deviations.
- `description` — the notable differences in Chinese, strongest first, e.g. `眼距偏寬（+1.2）`, `鼻子較挺（+0.9）`. Use it to check your portrait against the brief.
- `summary` — e.g. `女性・東亞・26 歲・身高 162 cm・頭身比 7.7・胸像`.

`portrait_check` codes: `UNKNOWN_PARAM`, `OUT_OF_LIMIT`, `EXAGGERATED`, `HEADS_TALL`, `HEIGHT_SCALED`, `HEAD_SCALE`, `EYELIDS_CROSS`, `EYES_CLOSED`, `EYES_WIDE`, `EYE_SPACING`, `NOSE_BEHIND_LIPS`, `LIPS_CROSS`, `MOUTH_WIDE`, `MOUTH_NARROW`, `OPEN_MOUTH`, `FACE_THIRDS`, `EAR_POSITION`, `ASYMMETRIC`, `NON_FINITE`. Each has a hint naming the parameters to change. `portrait_run` returns `checks.new` — problems the batch introduced — fix those before moving on.

## Workflow: from a text description

1. Decide sex, ethnicity and age → `portrait_new {preset, name, framing}` (then adjust `base.age`, ethnicity mix, `body.heightCm` with `portrait.set`).
2. Translate the description into **traits** (`portrait.applyTraits`). Match degree words with `amount`: 略 / 有點 ≈ 0.5, (plain) ≈ 0.8–1, 很 / 非常 ≈ 1.2–1.5.
3. Add specific **parameters** for what traits don't cover: build (`base.weight`, `base.muscle`), height, expression, head turn, framing.
4. **Verify**: `portrait_render` (front, 3/4, profile) and `portrait_measure` — compare `description` with the brief, adjust the biggest mismatches, repeat. Run `portrait_check` and fix warnings.
5. **Always finish with the 三視圖**: `portrait_export {format: "png"}` (no `views`) saves `exports/portraits/<name>_三視圖.png` — 正面 / 半側 / 側面 (front, left 3/4, left profile), head and shoulders, three 640 × 1080 cells on one 1920 × 1080 sheet with rounded labels (`scale: 2` → 3840 × 2160). Look at it before reporting, and hand it over as the final image. (`views: [...]` or `layout: "sheet"` gives the older captioned sheet with the current framing instead.)

## Workflow: from reference photos

Photos are analysed **locally** in the studio tab by MediaPipe Face Landmarker (478 landmarks, expression blendshapes); they are stored with the portrait in `portraits/refs/<id>/` (git-ignored) and never sent anywhere else. JPEG, PNG and WebP work; HEIC is converted on macOS by `portrait_add_reference`.

1. **Start close**: judge sex, age and ethnicity → `portrait_new {preset}` and `base.age`; apply traits for features that are obvious in the photo. The fit starts from these values and stays near them where the photos say little.
2. **Add 1–3 photos**: `portrait_add_reference {path, note}` — front and 3/4 (15–40°) views, sharp, face unobstructed, neutral or slight expression. The result says whether a face was found, the estimated camera (head turn, 35 mm focal length) and the current error. Profiles (90°) are not detected.
3. **Compare**: `portrait_compare {refId}` (add `frame: "head"` to see the crown, ears and head outline — the default face crop cuts them off) → image (photo | portrait through the photo's camera | overlay | landmarks) and a report: landmark error and per-region errors (% of the pupil distance), and **photo vs portrait** differences in % (eye width / opening, inner eye corners, nose width / length, mouth width, lips, philtrum, face and jaw width, lower face; + = larger in the photo).
4. **Fit**: `portrait_fit {expression: "neutral"}` adjusts the face groups (head shape, brows, eyes, nose, mouth, cheeks, chin) to all analysed photos as one undoable step and lists every changed parameter with a confidence. Brows: the fit compares MediaPipe's brow points with the sculpted brow's outline and adjusts the arch (`face.brow.arch`, `peak`) and the brow skin (`height`, `tilt`); set the gap, thickness, length and density by eye in the compare view — MediaPipe follows a brow's thickness and length only loosely, and on photos it puts a faint inner end where the hair gets dense (it reads the gap too wide). `dryRun: true` only suggests. `outline: true` (experimental) then also fits face / jaw / chin width and cheek fullness to the jaw and cheek outline: face width usually gets closer, but jaw width can get worse (a silhouette cannot tell jaw bone from cheek fullness), especially without an EXIF focal length. The outline measures in `portrait_compare` (face width in front of the ears, jaw width, lower face) are reliable either way.
5. **Correct by eye**: compare again; fix what the numbers and the overlay still show (face width, jaw, nose depth from a 3/4 photo) with `portrait.set` or traits, and re-compare. Give the photo's focal length when it has no EXIF and you know it: `portrait.updateReference {id, focal35}` (phones: main camera ≈ 26 mm, portrait mode ≈ 50–77 mm). Landmarks alone cannot recover it (on a real photo, 42–135 mm changed the fit error by < 0.1 %); for a studio-style portrait taken from a distance, 60–85 mm is a sensible guess.
6. Remove a photo with `portrait.removeReference {id}` (the image file stays, so undo works).
7. **Finish with the 三視圖** (`portrait_export {format: "png"}`, see step 5 above) — every portrait ends with that image.

What the fit can and cannot do (synthetic test: random faces rendered as photos, 2 views): it recovers the camera and pulls the landmarks close (median error ≈ 3.3 → 2.2 % of the pupil distance) and reliably improves the vertical proportions (face height, mid / lower face, chin) and nose width; eye-opening, lip thickness and nose depth are not reliable, and different parameter mixes can give the same look, so read `changed` as suggestions. Expect a good starting point, not a finished likeness — finish with steps 3 and 5.

## Recipes

Young East Asian woman, smiling, bust:
```json
[
 {"cmd": "portrait.applyPreset", "args": {"preset": "female-eastAsian"}},
 {"cmd": "portrait.applyTraits", "args": {"traits": ["鵝蛋臉", "杏眼", "雙眼皮", "小巧鼻", "櫻桃小嘴"], "amount": 0.8}},
 {"cmd": "portrait.set", "args": {"params": {"base.age": 24, "body.heightCm": 163, "expr.smile": 0.4, "pose.headYaw": -10}}}
]
```

Mature European man, strong features, head study:
```json
[
 {"cmd": "portrait.applyPreset", "args": {"preset": "male-european"}},
 {"cmd": "portrait.applyTraits", "args": {"traits": ["方臉", "深邃眼窩", "鷹勾鼻", "法令紋", "下顎線明顯"]}},
 {"cmd": "portrait.set", "args": {"params": {"base.age": 55, "head.age": 0.5, "face.brow.tilt": 0.3}}},
 {"cmd": "portrait.update", "args": {"framing": {"type": "head"}}}
]
```

Mild caricature (exaggeration):
```json
[
 {"cmd": "portrait.set", "args": {"params": {"body.headsTall": 5.5, "face.eyes.size": 1.4, "face.nose.length": -1.2, "face.chin.height": -0.8}}}
]
```

Take the face from one preset and keep the body:
```json
[{"cmd": "portrait.applyPreset", "args": {"preset": "female-european", "groups": ["head", "brow", "eyes", "nose", "mouth", "cheek", "chin", "ears"]}}]
```

## Gotchas

- Face-shape blends (`head.shape.*`) are strong: 0.2–0.5 is usually enough; 1.0 deforms the skull.
- MakeHuman's eye fissures are narrow; the presets lengthen them a little. `face.eyes.opening` at +1 already shows white above the iris.
- `expr.mouthOpen` shows the mouth interior (no teeth yet).
- `body.heightCm` far outside the MakeHuman range scales the whole figure, features included (`HEIGHT_SCALED`).
- Heads-tall below ~5.5 reads as caricature; below 4 is out of range.
- Each `portrait_fit` starts from the current values; running it again keeps moving toward the photos (and their measurement noise). Fit once, then correct by hand.
- MediaPipe's expression reading of a photo goes into `expr.*` with `expression: "estimate"`; use `"neutral"` for a neutral statue.
- `history.undo` cannot be mixed with other commands in one batch.
- Head outline from a photo: hair adds roughly 5–10 mm (more on top). `head.foreheadHeight` raises the crown strongly (≈ 38 mm per unit) and is the lever for the crown height; `head.width` widens the face as much as the skull (the camera fit cancels it) — to widen only the skull use `head.craniumWidth`, and judge it with `portrait_compare {frame: "head"}` (leave about 5 mm of hair at the sides, more on top). `head.temples` above ~0.5 makes a visible shoulder at the temples. `face.ears.height` moves the ears (≈ 11 mm at 0.8) but also drags the cheek outline in front of them a little (outline error +1 %).
- Renders are bald white sculptures with sculpted eyebrows; judge form, not hair or skin. Brow strands are a shading effect: they show in renders and the compare view, not in the mesh (`face.brow.texture` does not change the geometry).
