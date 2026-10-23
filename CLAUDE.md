# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A collection of custom StreamBIM widgets. A StreamBIM widget is a plain web page shown in an iframe inside StreamBIM's side panel; StreamBIM (Rendra) registers it from just **a widget name + a URL** and whitelists it per project (support@rendra.io). Everything is hosted from this one repo on GitHub Pages: `https://kasterna.github.io/streambim-widgets/<widget>/index.html`.

First widget: **`sok-armering/` ("Søk Armering")**, which lists rebar grouped by posisjonsnummer with click-to-highlight/zoom in both directions. Background on where it came from lives in local Claude memory, not in this public repo. **This repo is public: keep comments and docs free of references to other platforms' tools, customers, project names and local paths.**

See `README.md` for user-facing docs (Norwegian) and `docs/streambim-widget-api.md` for the API notes and gotchas. Read that file before writing a new widget.

## Commands

```bash
npm install
npm run dev      # http-server :8084 (also .claude/launch.json "streambim-widgets" for the Browser pane)
npm test         # node --test, unit tests in test/
npm run vendor   # copy node_modules/streambim-widget-api/dist into vendor/ after upgrading
```

No bundler or build step. Plain HTML/JS served as static files. Widgets load `../vendor/streambim-widget-api.min.js` as a classic script (exposes global `StreamBIM`).

## Architecture

- **Pure logic is split from DOM/API code** so it can be unit-tested in Node. `sok-armering/rebar-lib.js` is a UMD-style file (`window.RebarLib` in the browser, `module.exports` in tests) holding `FIELDS` (property-name candidates), `REBAR_SEARCHES`, `findProperty`, `groupRebar`, `sortRows`, `moveToTop`, `mapWithConcurrency`. `app.js` holds the connection, the StreamBIM calls and the rendering. Follow the same split for new widgets.
- **Real `getObjectInfo()` shape (confirmed live):** `properties` holds only IFC attributes and `@`-fields (`"@kind": "Reinforcing bar"`). All pset properties are in `groups[]` as `{label: Pset, content: {properties: [{key, value}]}}`, with values always as strings. `objectProperties(info)` merges both into one object (groups become nested psets, so keys read `Pset~Prop`). Always run `findProperty` on that, never on `info.properties` alone. A trimmed real response is in `test/fixtures/object-info.json`.
- `findProperty` also still accepts flat names, `Pset~Prop` keys and nested objects. It returns `{key, name, value}`. A candidate in `FIELDS` is either a string (exact name) or a **RegExp tested against the bare property name only, never the pset name**. Regexes exist because some exports prefix the name with a code (pset `MERKNADER`: `K200 Pos nr`, `K201 Stangdiameter`, `K202 Antall`, `K212 Formkode`, `K233 Kapplengde`, seen live on a second model). Add new naming schemes as new candidates, never by changing existing ones. A trimmed K-coded example is in `test/fixtures/object-info-kcoded.json`; the mock test data has a K-coded group too.
- **`findObjects` is unreliable as a filter.** Live, on a building with two models: `@kind = "Reinforcing bar"` returned 2125 of 3624 objects (correct), but values that don't exist in the model («Reinforcing mesh», «ReinforcingBar», `Common Type`…) returned **all 3624**. On the first, smaller building every value returned all objects. So the union in `REBAR_SEARCHES` can pull in every object (fetching info for 3624 objects took about a second), and `isRebarObject` always has to keep only `@kind` matching /reinforc/i. Hits per search value are logged. If a building ever has more than `SEARCH_LIMIT` (10000) objects, the unfiltered results get cut off arbitrarily, but the correct `Reinforcing bar` result is still part of the union.
- **One building can hold several models.** `document` in `getObjectInfo()` tells them apart (1000 and 1001 in the live project), `layer` is the file name. The list shows the rebar of ALL models in the active building together, so equal postnr in two models would merge into one row. A model filter would fix that if it ever matters.
- **`count` is bars, `objects` is IFC objects.** Revit exports a whole rebar set as one `IfcReinforcingBar` with an `Antall` property, so `groupRebar` sums `FIELDS.antall` and falls back to 1 per object. Whether Tekla/RIB per-bar objects also carry `Antall` (which would inflate the sum) is UNVERIFIED.
- **The StreamBIM README is wrong in several places. `docs/streambim-widget-api.md` → «Slik virker API-et egentlig» was read from StreamBIM's own app code, so trust that table.** In short: `highlightObject` only *selects* and is wiped by any search, `applyObjectSearch` returns `true` (not hits) and reads `rules` at the top level, and `colorCodeObjects({guid: "#rrggbb"})` colours objects *and* makes them the active search.
- **Marking a group** (`markGroup`). The order matters, because StreamBIM's searches are async:
  1. `colorCodeObjects({})` resets everything.
  2. `setSearchVisualizationMode("ORIGINAL")`, only when fading is off. FADED is StreamBIM's default after a reset.
  3. `colorCodeObjects(colorCodeMap(guids, "#ffd400"))`.
  4. On a row click only (model clicks don't move the camera): `applyObjectSearch({rules: [[guidSearchRule(guids, buildingId)]]})`, which resolves only when the search has finished, then `zoomToSearchResult()`.

  Two live failures came from the old order: calling `setSearchVisualizationMode` after colouring re-ran the previous search in parallel (only the first click worked, and bars showed green `HIGHLIGHTED` instead of yellow `COLOR_CODED`), and zooming right after colouring framed the previous search. Both list → model and model → list use `markGroup`. The «Resten av modellen ved valg» select (FADED default, HIDDEN, ORIGINAL; kept in `localStorage` under `sok-armering-resten`, renamed from the old on/off key so a stale "off" cannot silently disable fading) chooses what happens to the rest of the model. In dense, multi-coloured rebar the fade/hide is what makes the green selection visible. Clicking the selected row again calls `colorCodeObjects({})`. `buildingId` comes from `getBuildingId()` at connect and is re-read on every list refresh, because a StreamBIM project can have several buildings and everything (findObjects, zoom rules, floors) is scoped to the *active* one. The list line shows «· bygning N». A model that is in another building never shows up until the user selects that building in StreamBIM's model panel (no API for that). **The marked bars show in StreamBIM's green, not yellow, and that can't be fixed from the widget.** StreamBIM's `startSearchMode` downgrades a GUID colour code (no `type`) to HIGHLIGHTED, and no widget API reaches the code path that would honour it. Don't spend another round on the colour. StreamBIM's own search bar («Fremhever N objekter») also always shows during an active search.
- **3D check:** `hasGeometry(properties)` reads the `Geometry` group's `Faces Hi`/`Faces Lo` (0 means the object is in StreamBIM's data but has no 3D, e.g. after a bad import). `groupRebar` returns `missing3d` per row and in total. The widget shows it in the **Obj.** column (IFC objects, the same number StreamBIM's search bar shows; **Antall** is bars) and as a note above the list. The mock simulates it with `?uten3d=31,27`.
- **Single-object groups (Obj. 1) showed no marking live**, with fade or hide, while groups of 2+ objects worked. Root cause not found (see docs, «Enkeltobjekt»). `markGroup` therefore also selects (`highlightObject`) and flies (`gotoObject`, on row click) to the object directly when `row.objects === 1`, which doesn't depend on search. After every marking, `verifyMark` runs a read-only `findObjects` with the same `@guid in` rule and logs «StreamBIM fant N/M objekter»; fewer than expected shows a visible note. Failures in `markGroup` also show a note. If this still fails live, ask for the browser console (F12) first: look for «Failure on search-nodes endpoint query» or `invalidSearchRules`.
- «Test søk» only uses `findObjects` with top-level rules plus `getBuildingId()`, to learn whether rebar can be found with a filtering search (faster loading on large models). It also reports camera state + `unionBbox` of the group, in case we ever need our own framing.
- **Model values are rendered with `textContent`, never `innerHTML`.** They are external data.
- `main()` has a connect watchdog. `connectToParent()` only accepts the `document.referrer` origin and otherwise hangs forever; a page opened outside an iframe gets an immediate explanatory status instead.

## Verification limits: read before claiming something works

The agent has no logged-in StreamBIM session. There are three test pages in `dev/`, all sharing the fake API in `mock-api.js`:

- `mock-host.html` runs the widget against a fake host over the real penpal transport. URL params `format=flat|tilde|nested`, `kind=0` and `search=0` exercise the fallbacks.
- `streambim-host.html` runs the unchanged widget against **real** StreamBIM in embedded mode. It relays every API call and logs it, and opens StreamBIM either in an iframe or in its own window. In an iframe on another domain StreamBIM is not logged in, so the window mode is the default.
- `fake-viewer.html` stands in for StreamBIM, so `streambim-host.html?viewer=fake-viewer.html` can be tested without a login.

The mock API answers in the **real StreamBIM format by default** (`format=streambim`: attributes in `properties`, psets in `groups`). `findObjects` ignores its filter unless `findfilter=1`, because that's what real StreamBIM did. `mock-host.html` can also show a **real rebar model in 3D** (`dev/model-view.js`, three.js from `node_modules` through an import map). The model is made with `python tools/ifc-til-testmodell.py ARM.ifc --kontekst KON.ifc --navn x`, which writes `dev/models/x.json` plus `index.json`. That folder is gitignored, because project models must never be published. Picking is GPU-based (an id-colour render around the pointer), because raycasts miss 10 mm bars. `window.mockHost.view.pickAt(x, y)` lets you test picking without a mouse.

The built-in Browser pane has WebGL, but StreamBIM refused to start 3D inside an iframe there. The pane also turns `window.open` popups into same-tab navigation, and while the pane is hidden its timers are throttled to ~1 s (that's why the mock API has no artificial delays). To test the window mode, drive a separate headless Chrome profile over CDP (a throwaway script, not in this repo). What has been confirmed against real StreamBIM is listed in `docs/streambim-widget-api.md` under «Bekreftet mot ekte StreamBIM».

The mocks only prove the widget behaves correctly **given our assumptions**. These assumptions are still UNVERIFIED against real StreamBIM with a logged-in user and a rebar model:

- whether Tekla/RIB property names in `FIELDS` appear unchanged in StreamBIM (Revit export names are confirmed)
- whether `applyObjectSearch` with the rule format (or key/value) filters, so `zoomToSearchResult` frames only the group
- GUID uniqueness across federated models (`guids` is a flat list)

When the first live test reports back, record what was confirmed in `docs/streambim-widget-api.md` and drop the matching UNVERIFIED comments. If new property names turn up, **add** candidates to `FIELDS`; don't rename existing ones (models in other projects depend on them).

## Deployment

- This machine has **no `gh` CLI**. The owner pushes with **GitHub Desktop**; the agent does not `git push`. After changes, ask the owner to commit and push in GitHub Desktop and wait about 1 minute for Pages to rebuild.
- The repo must stay **public** (free GitHub Pages). It holds no secrets.
- StreamBIM fetches the page live from the URL, so code changes need no re-registration. Only a new widget (new name/URL) goes to Rendra.
- **Bump `?v=` on the script tags in the widget's `index.html` with every change.** It is the single source of the version: `app.js` reads it from `document.currentScript` and shows it in the footer and log. GitHub Pages sends `Cache-Control: max-age=600`, so browsers may run old files for up to 10 minutes after a push (this caused a false "still broken" report in the first live test). A new `?v=` makes fresh scripts load as soon as `index.html` itself is refetched, and avoids mixing a new page with old scripts. When a live tester reports "same error" right after a push, first ask which version the footer shows.
