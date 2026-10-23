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
- `findProperty` also still accepts flat names, `Pset~Prop` keys and nested objects. It returns `{key, name, value}`.
- **`findObjects` does not filter** (live: every value returned the same 255 objects). Rebar candidates come from the `REBAR_SEARCHES` union, and then `isRebarObject` keeps only `@kind` matching /reinforc/i. Hits per search value are logged.
- **`count` is bars, `objects` is IFC objects.** Revit exports a whole rebar set as one `IfcReinforcingBar` with an `Antall` property, so `groupRebar` sums `FIELDS.antall` and falls back to 1 per object. Whether Tekla/RIB per-bar objects also carry `Antall` (which would inflate the sum) is UNVERIFIED.
- **Zoom to group** tries `groupSearchQueries(row)`: first the README rule format `{filter: {rules: [[{buildingId, psetName, propKey, propValue}]]}}`, then `{key, value}`. Each goes through `applyObjectSearch(…, true)`. A result is only used if `isUsableGroupSearch` says it actually filtered (it contains the group and isn't "everything" for a smaller group). Otherwise the search is reset and the camera falls back to `gotoObject(firstGuid)`. Whether StreamBIM honours the rule format is still UNVERIFIED; the «Test søk» button in Feilsøking measures it live. Highlighting is per-GUID (`highlightObject`) with limited concurrency, because there is no bulk select.
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
