# Print-to-AR Creator Handoff Statement

Last updated: 2026-07-05

## Project

- Repository: `haruuharuki/print-img-ar`
- Local path: `G:\My Drive\print-image-ar-starter`
- Production viewer: `https://haruuharuki.github.io/print-img-ar/`
- Creator local URL: `http://127.0.0.1:8080/creator.html`
- Run local helper with `run_creator.bat`

## Working Rules

- Work local-first and read real files before editing.
- Use minimal changes and patch only related files.
- Do not rewrite whole files without a clear reason.
- Do not compile, stage, commit, push, or deploy unless the user explicitly asks.
- Keep the current AR scan, video overlay, photo/video capture, camera switch, and Save & Deploy Library flows working.
- `src/ar-library.js` is the source of truth for targets and per-target overlay settings.
- `assets/targets.mind` is generated output from enabled targets.
- Do not compile only a new target and overwrite `assets/targets.mind`; active targets must be compiled together.

## Current Architecture

- `index.html` is the production AR viewer.
- `src/ar-viewer.js` builds production target entities from `window.AR_LIBRARY.targets`.
- `src/ar-capture.js` handles photo/video capture, share, download, camera switch, and capture preview.
- `creator.html` is the local Creator UI.
- `src/creator-preview.js` handles Creator preview, per-target Overlay Adjust, Target Library Browser, and Save & Deploy Library UI.
- `src/mindar-target-compiler.js` handles Project Setup target image/video selection, browser compile, and save target to library.
- `tools/creator_helper.py` serves the local static site and helper APIs.
- `run_creator.bat` starts the local helper first, waits briefly, then opens `creator.html`.
- `src/ar-config.js` stores global UI/tracking settings, not per-target overlay transforms.
- `src/ar-library.js` stores target entries, paths, targetIndex, enabled status, and overlay transforms.

## Current Library

The library currently has two enabled targets:

- `vicky`
  - `targetIndex`: `0`
  - target image: `./assets/targets/vicky.png`
  - overlay video: `./assets/overlays/vicky.mp4`
- `nuwa`
  - `targetIndex`: `1`
  - target image: `./assets/targets/nuwa.png`
  - overlay video: `./assets/overlays/nuwa.mp4`

`src/ar-viewer.js` sets MindAR `maxTrack` from enabled target count and appends production target entities directly to the A-Frame scene.

## Completed Milestones

- Static MindAR + A-Frame viewer works on desktop localhost and iPhone Safari.
- Camera feed is visible behind AR canvas.
- Video overlay appears over detected printed target.
- Photo capture combines camera feed + AR overlay without UI.
- Video capture records composite canvas without audio.
- Camera switch works.
- Creator Project Setup can add/update a target into the local library.
- Browser-side MindAR target compiler prototype works for one target at a time, while recompiling all enabled targets for the library.
- Multi-target production viewer supports Vicky and Nuwa automatically, without dropdown.
- Overlay Adjust is per-target and saves target overlay back to `src/ar-library.js`.
- Save & Deploy Library validates/stages/commits/pushes only the library deploy set when the user confirms.
- Target Library Browser v1 exists in Creator.
- Task 5A.1 compacted the Library Browser layout so cards do not stretch into huge white panels.
- Task 5B merged Library `Edit` and `Adjust`: `Edit` now opens Overlay Adjust for the selected target.
- Task 5C added soft delete: `Delete` removes a target from the active library, recompiles remaining enabled targets, and moves deleted assets to `assets/_deleted/` for 7 days.
- Task 5D added Library Trash: deleted targets can be previewed and restored from `assets/_deleted/`.
- Trash `Clear all` permanently deletes deleted target folders only after the user types `DELETE`.
- Nuwa was soft-deleted during testing and restored successfully; the active library currently contains both Vicky and Nuwa.

## Target Library Browser v1

The Library button in Creator opens a panel that reads from `window.AR_LIBRARY.targets`.

It shows:

- target thumbnail
- target name
- target id
- enabled/disabled status
- targetIndex
- target image filename
- overlay video filename
- updatedAt
- muted overlay video preview

Actions:

- `Preview`: opens a preview modal with target image and overlay video.
- `Edit`: switches to Overlay Adjust and selects the target so the lower controls load its current overlay values.
- `Delete`: confirms deletion, recompiles remaining enabled targets, writes a new `assets/targets.mind`, removes the target from `src/ar-library.js`, and moves its target/overlay assets into `assets/_deleted/<target-id>-<timestamp>/`.
- `Trash`: opens deleted target folders found in `assets/_deleted/`.
- `Restore`: moves a deleted target image/video back into `assets/targets/` and `assets/overlays/`, adds the target back to `src/ar-library.js`, and recompiles all enabled targets.
- `Clear all`: permanently removes deleted target folders after exact `DELETE` confirmation.

Current limits:

- No enable/disable target.
- No reorder targetIndex.
- No Library UI recompile button.
- Replacing target image/video still happens through Project Setup, not the Library card `Edit` button.
- Deleted assets are retained locally for 7 days. The helper cleans expired folders the next time it starts.
- Restore requires the local helper to be restarted after code updates because Python keeps old endpoint code in memory while running.

## Save And Deploy Library

The Creator Save & Deploy Library flow should not use the old `/api/deploy-overlay` endpoint.

Current helper endpoints:

- `POST /api/library/save-target`
- `POST /api/library/delete-target`
- `POST /api/library/deleted-targets`
- `POST /api/library/restore-target`
- `POST /api/library/clear-deleted-targets`
- `POST /api/library/save-overlay`
- `POST /api/library/prepare-deploy`
- `POST /api/library/deploy`

Deploy set is expected to include only:

- `src/ar-library.js`
- `assets/targets.mind`
- referenced files in `assets/targets/`
- referenced files in `assets/overlays/`

It must not automatically include Creator source files unless the user is committing normal code changes manually.

## Important Risks

- iPhone Safari can be sensitive to video texture autoplay/unlock behavior. Keep muted + playsinline behavior.
- MindAR `targetIndex` must match compile order in `assets/targets.mind`.
- `maxTrack` must be at least the number of enabled targets to show multiple overlays at once.
- `assets/targets.mind` cannot be reliably reverse-inspected for target count, so validate by source images, manifest, and smoke tests.
- GitHub Pages can cache JS/assets. Use cache-busting or wait after push before mobile tests.
- Google Drive sync can leave Git lock files. Check Git status carefully before removing any `.git/*.lock` file.

## Recommended Next Tasks

1. Smoke test Trash restore/clear all on desktop with a disposable target.
2. Smoke test production viewer after push: Vicky, Nuwa, and both targets at once.
3. Add Library UI v2 later: enable/disable, replace asset from library card, and recompile all enabled targets.
4. Add clearer deploy/status feedback for GitHub Pages cache timing.

## Useful Checks

```powershell
node --check src\creator-preview.js
node --check src\mindar-target-compiler.js
node --check src\ar-viewer.js
node --check src\ar-capture.js
python -m py_compile tools\creator_helper.py
git diff --check
git status --short
```
