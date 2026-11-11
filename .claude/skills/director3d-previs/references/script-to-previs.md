# Script → previs lookup

Read this while planning the blocking and cameras for a new script, or when a script term has no obvious setup.
Numbers are what worked in 「誰先給台階」 (see `example-street-scene.mjs`); start from them, then check with
storyboard / snapshot.

Contents: 1. Timing budget · 2. Walking math · 3. Script terms → camera setup · 4. Mannequins and props ·
5. Light · 6. Extras and traffic · 7. Taipei arcade street

## 1. Timing budget

Write this table before any code, then keep every time in build.mjs derived from its constants.

| CUT | script estimate | previs seconds | beats (absolute time) |
|---|---|---|---|
| 1 | ~6 s | 0–3 | 0.2 line A |
| 2 | ~14 s | 3–9.6 | 3.6 line B, 4.0 hook, 4.5 shoulder switch, 6.0 slows, 7.2 stops, 9.3 she stops |
| … | | | |

- Script estimates often add up to 25–35 s. Fit them into the default 15 s by scaling every shot by the same
  factor, then nudge so each beat still has room. The longest shot in the script stays the longest.
- Holds after a line shrink the most (3 s → 1.6 s, 5 s → 2.3 s worked); name them in the report.
- Leave ≥ 0.3 s between a character stopping and the cut ("camera brakes, then cut").

## 2. Walking math

| What | Value |
|---|---|
| brisk walk (default) | 1.5 m/s |
| stroll | 1.1 m/s (the user found it slow) |
| ease-out stop over T s from speed v | covers v·T/3 (`kit.easeOutDistance`) |
| "third step shorter, then stops" | ease-out over 0.5 s |
| "half a step behind / catches up" | 0.35 m behind → level over ~0.9 s |
| scooter in town | 11 m/s |

Keys with no `ease` default to `inOut` (accelerate, decelerate). Constant motion needs `'linear'`.

## 3. Script terms → camera setup

| Script says | Setup |
|---|---|
| 基準距離, stabilizer walking backward in front of them (倒退跟拍) | `rig: 'dolly'`, `follow: {target: lead, offset: [x, 1.55, 6–7], space: 'world', lag: 0.2–0.25}`, `lookAt: {target, aim: 'feet', offset: [x, 1.2–1.4, 0]}`, `shake: {preset: 'walk', amount: 0.2}` |
| MLS, long lens, front | 60 mm at ~6.6 m (super35) |
| MS two-shot, a bit closer | 85 mm at ~6.3 m |
| MCU face, long lens | 100 mm at ~4.2 m |
| static MLS at base distance | 63 mm at ~6.3 m, tripod, no shake |
| camera does not stop with him, keeps going with her | follow HER only; he falls back in frame by himself |
| camera brakes when she stops, then cut | the follow lag gives the brake; cut ~0.3 s after she stops |
| 固定 / first static shot | tripod. Find the spot with `object.update {position}` + `camera.frame {keepPosition: true}`, read the values, write them into build.mjs |
| over the shoulder | `camera.frame {over, shoulder}`, then bake the numbers |
| reverse "from behind her" while he stands behind her | impossible literally (the camera would face away from him). Put the camera at her front shoulder looking back at him, her shoulder soft in the frame edge; tell the user |
| 失焦 / blurred into a patch of orange | the app has no depth of field. Use distance + long lens; put the intent in a marker |

`aim: 'feet'` plus an offset y is easier to control than `aim: 'head'`: raise y when heads get cropped in
long-lens tracking shots, lower it for more headroom.

## 4. Mannequins and props

- Poses: stand, walk, run, sit, talk, wave, point, phone, armsCrossed, handsOnHips, raiseHand, crouch, lie. Pose
  changes are instant; time them to the beat.
- One-armed poses use a fixed arm. Mirror the character with `scale: [-1, 1, 1]` to use the other arm (e.g. so
  his reaching hand is on her side).
- Can't be shown: facial expressions, lips pressed, breathing, thumbs, hands in pockets, speech, sound (sandals
  clacking). Write them as markers at their times; report them as "人偶做不出來".
- Props are boxes riding on a character via `kit.attached` (offsets = [right, up, forward] in their frame):

| Prop | Offsets |
|---|---|
| tote on right shoulder, 1.62 m woman | [0.24, 0.78, −0.03] (left shoulder: right = −0.24) |
| sunglasses pushed up on head, 1.78 m man | up 1.685, forward 0.075, pitch 35° |
| sunglasses on the eyes, same man | up 1.648, forward 0.098, pitch 0 |

## 5. Light

- Warm afternoon (暖色日光): preset `day`, not `golden` (too orange). Sun elevation ~50°, `shadows: true`,
  `fogDensity` ~0.2.
- Sun azimuth 0 = from north, 90 = from east. `kit.shadowOffset(az, el, h)` gives where a point h m up casts
  its shadow; use it to put tree shade / sun patches where the script wants them ("he stops in the sun").

## 6. Extras and traffic

- Pattern: decide the moment an extra must be somewhere ("crosses between them right after the line"), anchor
  them there (`walker {at, atT}` / `pathWalker {anchor}` / `vehicle {at, atT}`), and let the kit extend the walk
  back to t = 0 and on to the end. Start them behind the camera or outside the frame so they enter already moving.
- Keep extras out of the leads' lane in long-lens shots: one walking behind a lead for several seconds reads as
  a tail and steals the shot.
- Crossings between characters go after the line, not during it.
- Traffic keeps right in Taiwan: on a road west of the sidewalk, the lane next to the curb carries north-bound
  (−Z) traffic.
- In-place extras (on the phone, hosing the floor) may stand still in a non-walk pose.

## 7. Taipei arcade street (the example's set)

| Element | Position / size |
|---|---|
| sidewalk (red brick) | x −1.7 … 2.0 |
| curb | x −2.5 |
| street trees | x −2.05, every 7 m |
| arcade pillars | x 2.25, one per shopfront (4–7 m apart) |
| arcade floor | x 2.2 … 5.0 |
| shopfronts / upper floors | x 7.4 / x 6.0 at y 3.6 |
| road | 7 m wide, centered x −6, center line |
| opposite sidewalk / houses | x −11 / x −16.5 |

Walk extras at x −1.5 (curb side), 1.1 (middle) or 3.0–4.0 (under the arcade) to clear trunks and pillars.
