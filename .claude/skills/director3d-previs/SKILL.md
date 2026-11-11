---
name: director3d-previs
description: Turns a shot-by-shot script (分鏡腳本) into a Director Console 3D previs (blocking, extras, cameras, cuts, MP4) and revises it on notes. Use when the user says 開一個新的專案處理以下的戲, 把這場戲做成預視, previs, 3D 導演台, 分鏡轉 3D, or gives previs notes (太長了, 走快一點, 路人突然才動). Not for writing the shot script itself (→ shot-script-director).
compatibility: Needs the Director Console 3D repo with its director3d MCP server, and Node 23.6+ for the check scripts.
---

# Director Console 3D previs from a shot script

Build a low-poly previs of a scripted scene in Director Console 3D: street or room set, actors' blocking, extras,
one camera per CUT, the edit, an exported MP4. The previs is used as a position-continuity reference for a video
model (Seedance), so who stands where, distances and screen direction must hold across cuts.

The repo's `AGENTS.md` documents the commands, axes and units; this skill is the workflow and the user's
standards on top of it. `<skill>` below means the folder holding this file.

## Rules

1. **Total length 15 s or less** unless the user or script names another length. A 30-s first cut came back
   with "太長了 15秒就好", and the video model it feeds takes ~15 s. When the script's estimates add up to more,
   scale every shot down by the same factor, keep every beat and its order, and say which holds got shorter.
2. **Walk-and-talk pace 1.5 m/s.** 1.1 m/s got "走快一點".
3. **Extras and vehicles never start, stop or freeze on camera.** Each passer-by and vehicle moves from t = 0 to
   the end, entering and leaving frames already in motion (start them behind the camera or outside the frame).
   Only in-place action (phone call, hosing the floor) may stand still, in a non-walk pose. No `crowd` in pose
   `walk`/`mixed` where a camera sees it: it is one static mesh frozen mid-stride. `check-extras.mjs` must pass.
4. **Follow the script, don't rewrite it.** One camera per CUT (`cut1`, `cut2`… with the script's shot in its
   name), cut times = cumulative shot lengths, the script's shot size / lens / movement per cut. Every line of
   dialogue and every performance beat becomes a marker at its time. When the script's geometry is impossible,
   take the nearest reading that keeps its intent and tell the user.
5. **The build script is the source of truth.** Generate the whole project from `scenes/<project-id>/build.mjs`
   in the repo (the scratchpad is wiped after the session). Make every change there and regenerate; a fix made
   only with `run_commands` or by hand in the JSON disappears at the next regeneration.
6. **Verify before every export** with the checks in step 5 below; send the MP4 only when they pass.
7. **Report in the user's language** (usually Traditional Chinese), in the format at the end of this file.

## Workflow

### 1. Plan on paper

- Read the whole script. List per CUT: shot, lens, camera movement, who does what, lines, the estimate.
- Make the timing budget table (`references/script-to-previs.md` §1) fitting rule 1, and decide positions:
  walking toward the camera = toward +Z, the street running along Z.
- Check exact params of the asset types you need: `list_asset_types` (MCP) or `src/core/assetTypes.ts`.
- Read `references/script-to-previs.md` for script-term → camera setups, walking math, props, light and extras.

### 2. Create the project and the scene folder

```bash
# after new_project {name, template: "blank"} returned the id
mkdir -p scenes/<id>
cp <skill>/scripts/previs-kit.mjs scenes/<id>/
```

Write `scenes/<id>/build.mjs`. Copy patterns from `references/example-street-scene.mjs` (a complete 15-s,
4-cut street scene on the kit). Order: timing constants and blocking functions → set → leads (+ props with
`kit.attached`) → extras (`kit.walker`, `kit.pathWalker`, `kit.scooter`/`kit.vehicle`) → cameras (`kit.camera`) →
`kit.writeProject(file, scene, {name, notes, settings, cuts, markers})`.

Derive every beat time from the constants (speed, shot lengths), so a note like "shorter" or "faster" is a
one-line change.

### 3. Generate

```bash
node scenes/<id>/build.mjs projects/<id>.json
```

The open app tab reloads the file as one undoable step. Fix any `warning:` lines the kit prints, then run
`validate_project`.

### 4. Place static cameras

Track shots are set in build.mjs (follow + lookAt). For static shots, find the spot interactively:
`object.update {id, position}` then `camera.frame {camera, target, shot, keepPosition: true}`, look with
`snapshot`, then write the final position / focal length / lookAt into build.mjs and regenerate.

### 5. Verify

Run all of these, fix, regenerate, repeat:

1. `check_scene` (MCP). If the tool is missing (server started before an app update), run
   `node <skill>/scripts/check-scene.mjs projects/<id>.json` from the repo root. Fix OVERLAP (paths through
   pillars, trees, people), CROSSED_LINE, SUBJECT_HIDDEN, KEYS_AFTER_END.
2. `node <skill>/scripts/check-extras.mjs projects/<id>.json` from the repo root: extras and vehicles that
   start, stop or freeze in a live shot, which `check_scene` doesn't look for. It must print ✓.
3. `plan_view` at the key beats: blocking, distances, which side of the line each camera is on.
4. `storyboard` with times just before and after every cut, at every beat, and when extras or vehicles enter
   a frame. Check heads aren't cropped, props sit where they should, the leads read clearly.
5. `snapshot {labels: true}` for anything ambiguous, and to confirm any `view_camera` result where an object
   fills the whole frame (objects beside or behind the lens are reported that way).

### 6. Export and send

`export_video {filename: "<片名>_previs_v<N>[_note]", tier: "1080p", burnIn: {timecode: true, camera: true}}` —
no `.mp4` in the filename (the tool adds it, and `x.mp4` became `x.mp4.mp4`). Send the file to the user and
keep older versions.

## Revising after notes

1. Diff `projects/<id>.json` against `scenes/<id>/generated.json` (written by the kit). If they differ, the user
   edited in the app: ask before regenerating, or port their edits into build.mjs. A project with no
   `scenes/<id>/` (made in the UI or another session): small fixes go through `run_commands`; for a retime or
   more than a few objects, first write a build.mjs that reproduces the project (copy the set and the leads'
   keys, rebuild extras with the kit), check it matches with `plan_view`/`storyboard`, then change it.
2. Back up the current file: `cp projects/<id>.json scenes/<id>/backup-v<N>.json`.
3. Edit build.mjs, regenerate, run all of step 5, export as v<N+1>.

| Note | Change |
|---|---|
| 太長了 / make it N s | shot-length constants and speed; markers follow because they use the same constants; report the new table, which holds shrank, changed distances |
| 走快一點 / slower | speed constant; stop distances follow from `easeOutDistance` |
| an extra or vehicle "suddenly starts moving" | rebuild it as `walker` / `pathWalker` / `vehicle` anchored at the moment it must be in place, starting off-screen at t = 0 and moving to the end |
| a shot reads wrong | change that camera only; re-check the cuts on both sides |

## Report format

Reply in the user's language:

- one line: what is done and the MP4 path (as a link);
- a table: 鏡頭 | 時間 | 內容 (beats with times);
- "會影響你看片的改動": what changed that they'll notice (shorter holds, distances, replaced extras);
- "我自己做的決定": readings of ambiguous or impossible script details;
- "人偶做不出來的部分": performance kept only as markers;
- where the build script and backups are.

## Gotchas

- Extras held their first keyframe: they stood still until their first key and then "started" right as the
  camera saw them (the user's note). Key them from t = 0; `check-extras.mjs` catches it.
- A passer-by walking behind the lead for seconds in an 85-mm shot read as a tail and stole the shot.
- An extra's path passed 0.28 m from an arcade pillar (clipping). `check_scene` OVERLAP finds it.
- The scooter rode south in the curb lane: wrong-way for Taiwan. Keep right.
- Preset `golden` made "warm afternoon" too orange; `day` was right.
- Heads were cropped in long-lens tracking shots: raise the lookAt offset y or shorten the lens.
- `camera.frame` `keepPosition` takes `true`, not coordinates (INVALID_ARGS).
- The `point` pose uses one fixed arm; mirror the character (`scale: [-1, 1, 1]`) to reach with the other.
- Sunglasses keyed only at the character's key times slid down his face for 2.5 s between keys. Use
  `kit.attached`, which samples every 0.1 s.
- A key without `ease` is `inOut`: constant-speed movers need `'linear'`.
- The app has no depth of field (camera `dof` was removed). "失焦" can only be distance and lens.
