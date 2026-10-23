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

- **Pure logic is split from DOM/API code** so it can be unit-tested in Node. `sok-armering/rebar-lib.js` is a UMD-style file (`window.RebarLib` in the browser, `module.exports` in tests) holding `FIELDS` (property-name candidates), `REBAR_KINDS`/`rebarCandidates`, `findProperty`, `groupRebar`, `guidSearchRule`, `filterRows` (search field), `exportItems`/`exportSamples`/`exportGaps` (fast loading), `sortRows`, `moveToTop`, `mapWithConcurrency`. `app.js` holds the connection, the StreamBIM calls and the rendering. Follow the same split for new widgets.
- **Real `getObjectInfo()` shape (confirmed live):** `properties` holds only IFC attributes and `@`-fields (`"@kind": "Reinforcing bar"`). All pset properties are in `groups[]` as `{label: Pset, content: {properties: [{key, value}]}}`, with values always as strings. `objectProperties(info)` merges both into one object (groups become nested psets, so keys read `Pset~Prop`). Always run `findProperty` on that, never on `info.properties` alone. A trimmed real response is in `test/fixtures/object-info.json`.
- `findProperty` also still accepts flat names, `Pset~Prop` keys and nested objects. It returns `{key, name, value}`. A candidate in `FIELDS` is either a string (exact name) or a **RegExp tested against the bare property name only, never the pset name**. Regexes exist because some exports prefix the name with a code (pset `MERKNADER`: `K200 Pos nr`, `K201 Stangdiameter`, `K202 Antall`, `K212 Formkode`, `K233 Kapplengde`, seen live on a second model). Add new naming schemes as new candidates, never by changing existing ones. A trimmed K-coded example is in `test/fixtures/object-info-kcoded.json`; the mock test data has a K-coded group too.
- **`findObjects` is unreliable as a filter.** Live, on a building with two models: `@kind = "Reinforcing bar"` returned 2125 of 3624 objects (correct), but values that don't exist in the model («Reinforcing mesh», «ReinforcingBar», `Common Type`…) returned **all 3624**. On the first, smaller building every value returned all objects (consistent with the same quirk, since every object there was rebar). Rules (`{rules: [[…]]}`) always filter. `findAllRebarGuids` exploits the quirk: it also searches `UNKNOWN_KIND`, and `rebarCandidates` drops every `REBAR_KINDS` result that holds exactly the same objects as that probe (compared by content, so results capped at `SEARCH_LIMIT` still work). Info is then fetched only for real rebar (3624 → 2125 objects in the live building; info for 3624 took ~21 s). If no search filtered, it falls back to everything, so it is never worse than the old union. `isRebarObject` still keeps only `@kind` matching /reinforc/i. Hits per value are logged.
- **Fast loading** (`fetchRebarViaExport`): for each `@kind` that filtered, one `getObjectInfoForSearch({filter: {key: "@kind", value}, page: {limit: 10000}, fieldUnion: true})` instead of one `getObjectInfo` per object. It returns StreamBIM's search export `{header, data: [{GUID, "Pset~Prop": value}]}` (read from StreamBIM's code; it creates a server search but does not touch the 3D view). `exportItems` turns rows into nested psets so `findProperty`/`hasGeometry` read them like `getObjectInfo`. The format is undocumented and `fieldLimit` can't be set from the widget, so the result is only used if its GUIDs equal the `findObjects` set and `exportSamples` (one object per postnr naming scheme, plus middle and last) show no `exportGaps` against `getObjectInfo`. Otherwise it logs why and falls back to per-object fetching. With no filtering `@kind` it always uses per-object fetching (export rows carry no `@kind`). The log line «Hurtighenting: N s» / «Henting per objekt: N s» shows which path ran. Mock: `eksport=kutt` (rows with only GUID and Name) and `eksport=0` (unsupported) exercise the fallback.
- **Search field** (`#postnr-filter`): `renderTable` shows `filterRows(rows, query)` (case-insensitive substring of postnr) with an «N av M» counter. Enter selects the first match, Esc clears, and a 3D click on a row the filter hides clears the filter.
- **One building can hold several models.** `document` in `getObjectInfo()` tells them apart (1000 and 1001 in the live project), `layer` is the file name. The list shows the rebar of ALL models in the active building together, so equal postnr in two models would merge into one row. A model filter would fix that if it ever matters.
- **`count` is bars, `objects` is IFC objects.** Revit exports a whole rebar set as one `IfcReinforcingBar` with an `Antall` property, so `groupRebar` sums `FIELDS.antall` and falls back to 1 per object. Whether Tekla/RIB per-bar objects also carry `Antall` (which would inflate the sum) is UNVERIFIED.
- **The StreamBIM README is wrong in several places. `docs/streambim-widget-api.md` → «Slik virker API-et egentlig» was read from StreamBIM's own app code, so trust that table.** In short: `highlightObject` only *selects* and is wiped by any search, `applyObjectSearch` returns `true` (not hits) and reads `rules` at the top level, and `colorCodeObjects({guid: "#rrggbb"})` colours objects *and* makes them the active search.
- **Marking a group** (`markGroup`). The order matters, because StreamBIM's searches are async:
  1. `colorCodeObjects({})` resets everything.
  2. `setSearchVisualizationMode(mode)` unless the mode is FADED, StreamBIM's default after a reset.
  3. `applyObjectSearch({rules: [[guidSearchRule(guids, buildingId)]]})`, which resolves only when the search has finished.
  4. On a row click only (model clicks don't move the camera): `zoomToSearchResult()`.
  5. `verifyMark` (read-only `findObjects` with the same rule).

  Until version .12, step 3 was `colorCodeObjects(map)`. StreamBIM ignores the colour anyway and `colorCodeObjects` always uses `in` (which fails for one object), so a plain search gives the same view for every group size. Every call that changes the 3D view goes through `updateView`, a one-at-a-time queue that skips a waiting call when a newer click arrives, so a double-click (select + clear) or rapid clicks can't interleave and leave 3D out of step with the list. Changing «Resten av modellen ved valg» re-marks the selected group without zoom.

  Two live failures came from the old order: calling `setSearchVisualizationMode` after colouring re-ran the previous search in parallel (only the first click worked, and bars showed green `HIGHLIGHTED` instead of yellow `COLOR_CODED`), and zooming right after colouring framed the previous search. Both list → model and model → list use `markGroup`. The «Resten av modellen ved valg» select (FADED default, HIDDEN, ORIGINAL; kept in `localStorage` under `sok-armering-resten`, renamed from the old on/off key so a stale "off" cannot silently disable fading) chooses what happens to the rest of the model. In dense, multi-coloured rebar the fade/hide is what makes the green selection visible. Clicking the selected row again calls `colorCodeObjects({})`. `buildingId` comes from `getBuildingId()` at connect and is re-read on every list refresh, because a StreamBIM project can have several buildings and everything (findObjects, zoom rules, floors) is scoped to the *active* one. The list line shows «· bygning N». A model that is in another building never shows up until the user selects that building in StreamBIM's model panel (no API for that). **The marked bars show in StreamBIM's green, not yellow, and that can't be fixed from the widget.** StreamBIM's `startSearchMode` downgrades a GUID colour code (no `type`) to HIGHLIGHTED, and no widget API reaches the code path that would honour it. Don't spend another round on the colour. StreamBIM's own search bar («Fremhever N objekter») also always shows during an active search.
- **3D check:** `hasGeometry(properties)` reads the `Geometry` group's `Faces Hi`/`Faces Lo` (0 means the object is in StreamBIM's data but has no 3D, e.g. after a bad import). `groupRebar` returns `missing3d` per row and in total. The widget shows it in the **Obj.** column (IFC objects, the same number StreamBIM's search bar shows; **Antall** is bars) and as a note above the list. The mock simulates it with `?uten3d=31,27`.
- **Single-object groups (Obj. 1): StreamBIM's `@guid in` rule finds NOTHING with only one value** (live: `verifyMark` logged «fant 0/1» for every Obj. 1 group, while 2+ objects gave N/N). `colorCodeObjects` always searches with `in`, so a one-key colour map marks nothing. `guidSearchRule` therefore returns plain equality (`{propKey: "@guid", propValue}`, no operator) for one guid (confirmed live in .12). After every marking, `verifyMark` runs a read-only `findObjects` with the same rule and logs «StreamBIM fant N/M objekter»; fewer than expected shows a visible note, and a good result brings back the note from loading (`listNote`). The mock reproduces the quirk (`in` with one value matches nothing). Look for «fant N/M» in the log first when marking fails.
- **Model values are rendered with `textContent`, never `innerHTML`.** They are external data.
- `main()` has a connect watchdog. `connectToParent()` only accepts the `document.referrer` origin and otherwise hangs forever; a page opened outside an iframe gets an immediate explanatory status instead.

## Verification limits: read before claiming something works

The agent has no logged-in StreamBIM session. There are three test pages in `dev/`, all sharing the fake API in `mock-api.js`:

- `mock-host.html` runs the widget against a fake host over the real penpal transport. URL params `format=flat|tilde|nested`, `kind=0` and `search=0` exercise the fallbacks.
- `streambim-host.html` runs the unchanged widget against **real** StreamBIM in embedded mode. It relays every API call and logs it, and opens StreamBIM either in an iframe or in its own window. In an iframe on another domain StreamBIM is not logged in, so the window mode is the default.
- `fake-viewer.html` stands in for StreamBIM, so `streambim-host.html?viewer=fake-viewer.html` can be tested without a login.

The mock API answers in the **real StreamBIM format by default** (`format=streambim`: attributes in `properties`, psets in `groups`). `findObjects` answers like real StreamBIM: rules always filter, and key/value filters when the value exists but returns every object for a value that doesn't (`findfilter=0` = key/value never filters, to test the fallback). `mock-host.html` can also show a **real rebar model in 3D** (`dev/model-view.js`, three.js from `node_modules` through an import map). The model is made with `python tools/ifc-til-testmodell.py ARM.ifc --kontekst KON.ifc --navn x`, which writes `dev/models/x.json` plus `index.json`. That folder is gitignored, because project models must never be published. Picking is GPU-based (an id-colour render around the pointer), because raycasts miss 10 mm bars. `window.mockHost.view.pickAt(x, y)` lets you test picking without a mouse.

The built-in Browser pane has WebGL, but StreamBIM refused to start 3D inside an iframe there. The pane also turns `window.open` popups into same-tab navigation, and while the pane is hidden its timers are throttled to ~1 s (that's why the mock API has no artificial delays). To test the window mode, drive a separate headless Chrome profile over CDP (a throwaway script, not in this repo). What has been confirmed against real StreamBIM is listed in `docs/streambim-widget-api.md` under «Bekreftet mot ekte StreamBIM».

The mocks only prove the widget behaves correctly **given our assumptions**. These assumptions are still UNVERIFIED against real StreamBIM with a logged-in user and a rebar model:

- whether Tekla/RIB property names in `FIELDS` appear unchanged in StreamBIM (Revit and K-coded export names are confirmed)
- the faster loading in .13 (`rebarCandidates` and the `getObjectInfoForSearch` export path): built on the logged live counts and StreamBIM's code, not yet run live
- GUID uniqueness across federated models (`guids` is a flat list)

When the first live test reports back, record what was confirmed in `docs/streambim-widget-api.md` and drop the matching UNVERIFIED comments. If new property names turn up, **add** candidates to `FIELDS`; don't rename existing ones (models in other projects depend on them).

## Deployment

- This machine has **no `gh` CLI**. The owner usually pushes with **GitHub Desktop**. Git Credential Manager is set up, so the agent can `git commit` and `git push`, but only when the owner says so in chat. Pages rebuilds in about 1 minute.
- The repo must stay **public** (free GitHub Pages). It holds no secrets.
- StreamBIM fetches the page live from the URL, so code changes need no re-registration. Only a new widget (new name/URL) goes to Rendra.
- **Bump `?v=` on the script tags in the widget's `index.html` with every change.** It is the single source of the version: `app.js` reads it from `document.currentScript` and shows it in the footer and log. GitHub Pages sends `Cache-Control: max-age=600`, so browsers may run old files for up to 10 minutes after a push (this caused a false "still broken" report in the first live test). A new `?v=` makes fresh scripts load as soon as `index.html` itself is refetched, and avoids mixing a new page with old scripts. When a live tester reports "same error" right after a push, first ask which version the footer shows.
