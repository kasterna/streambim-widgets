# StreamBIM widget-API — arbeidsnotater

Kortversjon av [`streambim-widget-api`](https://github.com/streambim/streambim-widget-api) v3.0.0 (siste versjon på npm per 2026-10-23), lest fra pakkens egen kildekode, README og demoer i `node_modules/streambim-widget-api/` — pluss det vi har lært selv. Hver påstand er merket med hvor den kommer fra.

## Hvordan en widget kobles inn i StreamBIM

- En widget er en **vanlig nettside som StreamBIM viser i en iframe** i sidepanelet. StreamBIM trenger bare **widget-navn + URL**.
- Widgets må **godkjennes (whitelistes) og slås på per prosjekt** av Rendra: support@rendra.io *(pakkens README)*. Det finnes ingen selvbetjent registrering.
- URL-en må være **HTTPS** og siden må tillate å bli lagt i iframe (ingen `X-Frame-Options: DENY` / streng `frame-ancestors`). GitHub Pages oppfyller begge deler.
- Gi URL-en med `index.html` på slutten. Da unngås omdirigering fra `/mappe` til `/mappe/`.

## Tilkobling

```html
<script src="../vendor/streambim-widget-api.min.js"></script>
<script>
  StreamBIM.connectToParent(window.parent, {
    pickedObject: (result) => console.log(result.guid, result.point),
  }).then(() => StreamBIM.API.getProjectId());
</script>
```

- `connectToParent()` gir ikke tilbake API-et. Det havner på **`StreamBIM.API`**, og alle kall gir et Promise *(kilde: `src/index.js`)*.
- **Fallgruve:** `connectToParent()` godtar kun meldinger fra originen i `document.referrer` *(kilde: `src/index.js`)*. Mangler referrer, kommer tilkoblingen aldri i stand, og promiset verken løses eller avvises. Legg derfor alltid inn en vakthund med tidsfrist, slik Søk Armering har.
- Transporten er [penpal](https://github.com/Aaronius/penpal) v7, som er bakt inn i `dist`-filen. Kaller du en metode verten ikke har, avvises kallet med en penpal-feil.
- Feil fra StreamBIM kommer som `{ code, detail? }` *(README)*.

## Hendelser (callbacks i `connectToParent`)

| Callback | Når | Kilde |
|---|---|---|
| `pickedObject({guid, point})` | Brukeren klikker et objekt. `point` er `[x,y,z]` | README og demo |
| `spacesChanged(guids)` | Kameraet går inn i eller ut av et rom | README og demo |
| `floorChanged(floorId)` | Aktiv etasje endres | README |
| `cameraChanged(state)` | Kameraet flytter seg (mange hendelser) | README og demo |
| `didExpand()` / `didContract()` | Widget-panelet utvides eller trekkes sammen | kun demo |
| `beforeInit()` | Kun i *embedded*-modus (`connectToChild`) | README |

`pickedObject` kommer bare fra brukerklikk, ikke fra våre egne `highlightObject()`-kall *(README og demo, ikke verifisert live)*.

## API-metoder vi bruker eller sannsynligvis får bruk for

| Metode | Merknad |
|---|---|
| `getProjectId()`, `getBuildingId()`, `getUserEmail()` | |
| `findObjects({key, value, limit})` → `guid[]` | Enkelt søk på én egenskap. `key: '@kind'` = IFC-klassen uten `Ifc` (demoen bruker `'Door'`/`'Space'`) |
| `getObjectInfo(guid)` → `ObjectInfo` | **Formen er ikke dokumentert.** Demoen bruker `.properties[navn]` (av og til en array, se `['System Global Id'][0]`) og `.center` |
| `getObjectInfoForSearch({filter, page, sort})` | Info for et helt søkeresultat i ett kall. Hvordan GUID-ene er koblet til resultatet er ukjent |
| `applyObjectSearch(query, replace)` → `guid[]` | Gjør søket til aktivt utvalg |
| `setSearchVisualizationMode('HIDDEN'\|'FADED'\|'ORIGINAL')` | Hvordan objekter utenfor søket vises |
| `zoomToSearchResult()` | Rammer inn hele det aktive søket. Det er **den eneste måten å zoome til flere objekter på** |
| `resetObjectSearch()` | |
| `highlightObject(guid)` / `deHighlightObject` / `deHighlightAllObjects()` | Kun ett objekt per kall. Det finnes ingen samlet "velg disse" |
| `gotoObject(guid)` | Kamera til ett objekt |
| `hideObject` / `showObject` / `showAllObjects` | |
| `colorCodeObjects({guid: 'hex'})`, `colorCodeObjectsWithLegends({data, legends})` | Hex uten `#` i README-eksemplene. Tomt kart nullstiller |
| `valuesForObjectProperty('Pset~Egenskap')` | Forteller at StreamBIM bruker `Pset~Egenskap`-notasjon |
| `setShowExpandButton(bool)`, `setExpanded(bool)` | Viser utvid-knappen på widget-panelet |
| `takeScreenshot()`, `getMapImage()`, `getAnnotatedFloorplan(point)` | |
| `makeApiRequest({url, method, body})` | Autentisert REST-kall mot StreamBIM, f.eks. `/pgw/project-XXXX/api/v1/ifc-searches`. Svaret er rå tekst som må `JSON.parse`-es |

Hele lista står i `node_modules/streambim-widget-api/README.md`. Den mest komplette brukseksempel-samlingen er `demo/index.html` i samme mappe.

## Viktige begrensninger i API-et

- **Objekt-ID** er IFC GUID (string). Om GUID-er er unike på tvers av flere IFC-filer i samme prosjekt, er ikke dokumentert.
- **Objekter hentes bare via søk** (`findObjects`). Det finnes ikke noe filter for «kun synlige objekter».
- **Egenskaper** kommer som et `properties`-kart med udokumentert form. Vær forberedt på flate navn, `Pset~Egenskap`-nøkler og nestede Pset-objekter.
- **Flere objekter kan ikke velges i ett kall.** Bruk `highlightObject` ett og ett.
- **Zoom til flere objekter** går bare via `applyObjectSearch` + `zoomToSearchResult`.
- **Klikk i modellen** kommer som `pickedObject`, og bare fra brukerklikk.

## Lokal testing uten StreamBIM

`dev/mock-host.html` etterligner StreamBIM-verten. Den legger widgeten i en iframe og svarer på API-kallene via `StreamBIM.connectToChild()`, altså samme penpal-transport som ekte StreamBIM. Klikk på en rute i den falske 3D-visningen sender `pickedObject` til widgeten. Alle API-kall widgeten gjør, logges nederst.

Med URL-parametre kan du teste reservestiene:

- `format=flat|tilde|nested`: de tre egenskapsformene `getObjectInfo` kan tenkes å ha
- `kind=0`: verten støtter ikke `@kind`-søk
- `search=0`: verten støtter ikke `applyObjectSearch`

Mocken kan bare vise at widgeten oppfører seg riktig *gitt våre antagelser* om StreamBIM. Den første testen i et ekte StreamBIM-prosjekt er fortsatt fasiten.
