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
- Feil fra StreamBIM kommer ifølge README som `{ code, detail? }`, men ekte StreamBIM sender `{ code, debug }` (se under). Les derfor `code` og vis resten som det er.

## Slik virker API-et egentlig (lest i StreamBIM sin egen kode, 2026-10-23)

README-en stemmer ikke på flere punkter. Dette er lest i `app.streambim.com/webapp/default/assets/rendrao-*.js` (widget-API-ets handlere) og bekreftet der live-test har vist det samme. **Stol på dette fremfor README.**

| Kall | README sier | Hva StreamBIM faktisk gjør |
|---|---|---|
| `highlightObject(guid)` | highlight | **Velger** objektet (`selectObject`). Alle søk og fargekoder fjerner valget (`unselectObjects`). |
| `findObjects(q)` | `{key, value}` | Bygger `{rules: q.rules \|\| [[{propKey: q.key, propValue: q.value, buildingId: <brukerinnstilling>}]]}`. **`rules` leses på toppnivå.** Returnerer GUID-liste. |
| `applyObjectSearch(q)` | returnerer `guid[]` | Samme regelbygging som over, kjører StreamBIM sitt søke-highlight og **returnerer bare `true`**. `filter.rules` blir ignorert. |
| `getObjectInfoForSearch(q)` | | Leser regler fra **`q.filter.rules`** (eller `q.filter.key/value`), altså et annet sted enn de to over. |
| `colorCodeObjects({guid: farge})` | fargekod | Farger objektene **og** gjør dem til aktivt søk (`@guid in a\|b\|c`). Tomt kart fjerner farger og søk. |
| Farge | hex | Leses med three.js `new Color(...)`. Bruk **`"#rrggbb"`**, med `#`. **Men fargen vises ikke:** `startSearchMode` krever at fargekoden har en `type`, og det har ikke en GUID-fargekode. StreamBIM faller da tilbake til sin grønne søkefarge (`COLOR_CONSTANTS.highlight` = `[0, 0.9, 0]`) og logger «No color coding specified for color code visualization mode» i konsollen. Bekreftet live: stengene ble grønne. Ingen widget-funksjon kan sette egen markeringsfarge i denne StreamBIM-versjonen. |
| `setSearchVisualizationMode(m)` | | Setter hvordan objekter *utenfor* søket vises: `FADED` gir redusert opasitet, `HIDDEN` skjuler dem. Fargekodede objekter tegnes alltid fullt. |
| `zoomToSearchResult()` | | Rammer inn det aktive søket. Etter `colorCodeObjects` er det nøyaktig de fargede objektene. |
| `resetObjectSearch()` | | `resetIfcSearch`. |
| `getBuildingId()` | | `projectservice.building.id`, samme verdi som StreamBIM bruker i egne regler. |

**Flere bygninger i ett prosjekt (lest i koden):** et StreamBIM-prosjekt kan ha flere *bygninger* (f.eks. én per sted), hver med egne IFC-filer og etasjer. Den *aktive* bygningen er `usersettings.project.buildingId`, og den settes når du velger en bygning i modellpanelet (`selectBuilding`). `findObjects` bruker den som standard `buildingId`, og `getBuildingId()` og `getFloors()` gjelder den. En widget ser altså bare den aktive bygningen. Et API-kall for å bytte bygning finnes ikke. Hent `getBuildingId()` på nytt når lista oppdateres, og regn med at modeller i andre bygninger ikke vises før brukeren velger dem.

**Hvordan et søk tegnes:** `applySceneFilter` kjører asynkront. Når søket er ferdig, velger StreamBIM `COLOR_CODED` hvis det finnes en fargekode i det øyeblikket, ellers `HIGHLIGHTED` (StreamBIMs egen grønne søkefarge og «Fremhever N objekter»). Objekter utenfor søket får `outSearchMode`, og standard er `FADED`. `zoomToSearchResult` rammer inn bounding boxen til **siste ferdige** søk. `setSearchVisualizationMode` kjører `reloadSearch`, som starter det lagrede søket på nytt, parallelt med et søk som allerede er på vei.

**Oppskrift for «marker en gruppe og ton ned resten»**, som brukes av Søk Armering. Rekkefølgen er viktig:

```js
await API.colorCodeObjects({});                                  // 1. nullstill (resetIfcSearch): søk, farger, modus
if (!fade) await API.setSearchVisualizationMode("ORIGINAL");     // 2. bare ved «ikke ton ned»; FADED er standard
await API.colorCodeObjects(Object.fromEntries(guids.map((g) => [g, "#ffd400"])));   // 3. farg + søk
// 4. zoom (valgfritt): applyObjectSearch svarer først når søket er ferdig
await API.applyObjectSearch({ rules: [[{ buildingId, propKey: "@guid", operator: "in", propValue: guids.join("|") }]] });
await API.zoomToSearchResult();
```

**Enkeltobjekt (live, 2026-10-23) — årsak funnet:** regelen `{propKey: "@guid", operator: "in", propValue: "<ett guid>"}` finner **ingenting** når den bare har ÉN verdi. Loggen viste «StreamBIM fant 0/1 objekter» for hver gruppe med ett objekt, mens `in` med to eller flere guid ga N/N (3/3, 42/42, 2/2). `colorCodeObjects` søker alltid med `in`, så et fargekart med bare én nøkkel gir ingen markering, ingen nedtoning og ingen skjuling. Løsningen er vanlig likhet uten operator for ett objekt, `{propKey: "@guid", propValue: "<guid>"}`, som er formen StreamBIM bruker for rom. Widgeten bruker da `applyObjectSearch` med likhetsregelen i stedet for `colorCodeObjects`. Et lesende `findObjects` med samme regel kontrollerer treffene («StreamBIM fant N/M objekter»), og finner den 0 av 1, velger og flyr widgeten til objektet direkte (`highlightObject` og `gotoObject`). Et søk tegnes ved at StreamBIM henter søkenoder fra `/octtree/search-nodes/<bygning>/<søkeId>`. Feiler det kallet, står «Failure on search-nodes endpoint query» i nettleserkonsollen.

Resultat live (versjon 2026-10-23.6): gruppen markeres, resten tones ned, og zoomen treffer riktig. Det virker også ved flere klikk etter hverandre. Fargen blir likevel StreamBIMs grønne, og StreamBIMs egen søkelinje («Fremhever N objekter», med X for å avslutte) vises øverst. Begge deler er StreamBIMs standard for aktive søk, og en widget kan ikke endre det.

**Hvilke widget-funksjoner finnes faktisk** i denne StreamBIM-versjonen (fra koden): applyObjectSearch, colorCodeByProperty, colorCodeObjects, colorCodeSpaces, createObject, deHighlightAllObjects, deHighlightObject, findObjects, getAnnotatedFloorplan, getBuildingId, getCameraState, getFloors, getLayers, getMapImage, getObjectInfo, getObjectInfoForSearch, getSpaces, getUserEmail, getViewportState, goHome, gotoFloor, gotoObject, gotoSpace, hideGrids, hideObject, highlightObject, makeApiRequest, quickSearch, resetObjectSearch, setAuthToken, setCameraPosition, setCameraState, setExpanded, setLayers, setNavigationMode, setSearchVisualizationMode, setShowExpandButton, setSkyColor, setViewportState, showAllObjects, showGrids, showObject, takeScreenshot, valuesForObjectProperty, zoomToSearchResult. **Ikke** `colorCodeObjectsWithLegends`, `colorCodeSpacesWithLegends` eller `setStyles`, selv om README nevner dem.

**3D-geometri:** `getObjectInfo().groups` har en «Geometry»-gruppe med «Faces Hi»/«Faces Lo». Er de 0, finnes objektet i StreamBIMs data, men vises ikke i 3D, for eksempel etter en mangelfull IFC-import. Søk Armering teller og varsler om slike objekter.

Feil vi traff live før denne rekkefølgen:
- `setSearchVisualizationMode` etter `colorCodeObjects` kjørte det forrige søket parallelt. Bare første klikk virket, og stengene ble grønne i stedet for gule.
- `zoomToSearchResult` rett etter `colorCodeObjects` zoomet til forrige søk, fordi det nye ikke var ferdig.

**Venstre panel** (der widgeten bor) kan dras bredere eller smalere i høyre kant, fra 300 px til halve skjermen. Bredden lagres per prosjekt (`usersettings.project.sidebarWidth`). Utvid-knappen veksler til full skjerm. StreamBIM fanger musebevegelsen på dokumentet, så dra-håndtaket henger litt når musa er over widgetens iframe.

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
| `getObjectInfo(guid)` → `ObjectInfo` | Formen er ikke dokumentert, men nå bekreftet live. Pset-egenskapene ligger i `groups`, ikke i `properties` (se «Bekreftet mot ekte StreamBIM») |
| `getObjectInfoForSearch({filter, page, sort})` | Info for et helt søkeresultat i ett kall. Hvordan GUID-ene er koblet til resultatet er ukjent |
| `applyObjectSearch(query, replace)` | Gjør søket til aktivt utvalg. Returnerer `true`, ikke `guid[]` (se «Slik virker API-et egentlig») |
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

## Bekreftet mot ekte StreamBIM (2026-10-23)

### Widget i ekte prosjekt (Revit-eksport, IFC4X3, 255 armeringsobjekter)

- `connectToParent()` virker. Referrer er `https://app.streambim.com/`.
- **`getObjectInfo()` har denne formen** (forkortet; et fullt eksempel ligger i `test/fixtures/object-info.json`):
  ```js
  {
    layer: "…ARM",
    properties: {                      // bare IFC-attributter og @-felt
      "@kind": "Reinforcing bar",      // lesbar tekst, IKKE "ReinforcingBar"
      Name, "Long Name", Description, "Global Id", "Type Object Global Id",
      "@Building Storey": { "@iid": "1001", Name: "…" }, "@Group Layer", "@Document Id", BaseType: "ifcelement", …
    },
    groups: [                          // ett element per Pset (+ "Location", "Geometry", "Type")
      { label: "KS_Armering", source: "GRAPH",
        content: { properties: [ { key: "Posisjonsnummer", value: "31", valueType: "str", valueItem: "<base64>", measure: "label" }, … ] } },
    ],
    center: [x, y, z], bbox: [6 tall], floors: ["1001"], spaces: [], document: "1000", building: "1000", …
  }
  ```
  Verdiene i `groups` er alltid tekst (`"12385"`, `"1"`), også tall.
- `valueItem` er base64 av StreamBIM sin egen søkenøkkel, `ifcelement~KS_Armering~Posisjonsnummer~str~31`. StreamBIM adresserer altså egenskaper som *Pset + egenskap*.
- **`findObjects({key, value})` er upålitelig som filter.** I den første, lille bygningen ga hver søkeverdi de samme 255 objektene, også «Common Type», som ikke finnes. I en bygning med to modeller ga `@kind = "Reinforcing bar"` riktig 2125 av 3624 objekter, mens verdier som ikke finnes i modellen («Reinforcing mesh», «ReinforcingBar», …) ga **alle 3624**. Sjekk derfor alltid `@kind` på objektene etterpå. Å hente info for 3624 objekter tok omtrent ett sekund.
- **Flere modeller i samme bygning:** `getObjectInfo().document` skiller modellene (1000 og 1001 i det aktuelle prosjektet), og `layer` er filnavnet. Begge hadde `building: "1000"`, så ingen bygningsbytte var nødvendig. Et widget-søk dekker alle modellene i den aktive bygningen.
- **Ulike eksportprogram gir ulike egenskapsnavn:** Revit-eksporten har `Posisjonsnummer`/`Diameter`/`Antall` i pset `KS_Armering`. En annen modell har pset `MERKNADER` med navn som `K200 Pos nr.` (med punktum til slutt), `K201 Stangdiameter`, `K202 Antall`, `K212 Formkode` og `K233 Kapplengde`. Verdiene er tekst (`"25"`, `"5045"`). Widgeten leser dem med regulære uttrykk i `FIELDS`.
- **`highlightObject` ga ingen synlig markering** sammen med søk/zoom. Grunnen fant vi i StreamBIM-koden (se tabellen over): det er «velg», og søket fjerner valget. Siden versjon 2026-10-23.5 markeres grupper med `colorCodeObjects` i stedet.
- Om `findObjects` filtrerer når reglene sendes på toppnivå med riktig `buildingId`, er **ikke bekreftet ennå**. «Test søk» i widgetens Feilsøking måler det. Gjør den det, kan lista lastes raskere i modeller med mye annet enn armering.

### Testsiden mot app.streambim.com

Testet med `dev/streambim-host.html` mot `app.streambim.com` med en oppdiktet prosjekt-ID, uten innlogging og uten modell:

- `app.streambim.com/webapp/default/` sender ingen `X-Frame-Options`/`frame-ancestors`. StreamBIM kan altså legges i en iframe fra et hvilket som helst domene.
- **Embedded-modus godtar tilkobling fra en lokal side** (`http://localhost`), både i iframe (`connectToChild`) og i eget vindu (`connectToWindow`). `getProjectId()` og `setShowExpandButton()` svarte.
- **I en iframe på et annet domene er StreamBIM ikke innlogget.** Nettleseren deler ikke innloggingen. `getUserEmail()`, `findObjects()` osv. feiler da med `{"code":"unknown"}`. Eget vindu er førsteparts og skal bruke vanlig innlogging (ikke bekreftet med innlogget bruker ennå).
- **Feil kommer som `{ code: "unknown", debug: ... }`**, ikke `{ code, detail }` slik README sier.
- **`getCameraState()` gir `{ position: [x,y,z], quaternion: [4 tall] }`**. Det finnes ingen `target` eller `fov`, så et kamerabasert synlighetsfilter må regne retningen ut fra kvaternionen.
- `getLayers()` ga `{}` (uten innlasted modell).
- Inni rammen i Claude-appens nettleser meldte StreamBIM at 3D (WebGL) ikke kunne startes, og kjørte i «safe-mode» uten 3D. WebGL virker ellers i den nettleseren. Test StreamBIM i vanlig Chrome.

## Revit-eksport: ett IFC-objekt = et helt armeringssett

Sett i en Revit 2027-eksport (IFC4X3) med egen mal: hvert `IfcReinforcingBar` er et **helt armeringssett**, f.eks. 38 bøyler i én kantbjelke. Geometrien har én `IfcSweptDiskSolid` per stang, og antallet står i egenskapen `Antall`. Å telle objekter gir derfor altfor lavt antall stenger.

Widgeten summerer derfor `Antall` per postnr, og teller 1 per objekt der egenskapen mangler. I testmodellen ga det 1 010 stenger i 250 objekter, som stemmer med antall `IfcSweptDiskSolid` i fila.

**UVERIFISERT for Tekla og RIB:** Har hver enkelt stang der *også* `Antall` = gruppens størrelse, blir summen for høy. Sjekk dette i «Feilsøking» på første Tekla-/RIB-modell.

Egenskapsnavnene i den eksporten (`Posisjonsnummer`, `Diameter`, `Armeringslengde`, `Formkode`, `Antall`) ligger i et eget Pset. Alle unntatt `Diameter` var allerede med i widgetens kandidatliste.

## Lokal testing uten StreamBIM

`dev/mock-host.html` etterligner StreamBIM-verten. Den legger widgeten i en iframe og svarer på API-kallene via `StreamBIM.connectToChild()`, altså samme penpal-transport som ekte StreamBIM. Klikk på en rute i den falske 3D-visningen sender `pickedObject` til widgeten. Alle API-kall widgeten gjør, logges nederst.

Med URL-parametre kan du teste reservestiene:

- `format=flat|tilde|nested`: de tre egenskapsformene `getObjectInfo` kan tenkes å ha
- `kind=0`: verten støtter ikke `@kind`-søk
- `search=0`: verten støtter ikke `applyObjectSearch`

**Ekte armeringsmodell i 3D:** `python tools/ifc-til-testmodell.py ARM.ifc --kontekst KON.ifc --navn prosjekt` gjør en IFC om til `dev/models/prosjekt.json`, med forenklet geometri og alle egenskapssett. Mock-verten viser da modellen i 3D (three.js) i stedet for knapper:
- Klikk på en stang sender `pickedObject`.
- Highlight, søk og zoom fra widgeten vises i modellen.

Stengene plukkes med GPU-plukking (fargekodet tegning rundt pekeren), fordi en stråle bommer på 10 mm-stenger. `dev/models/` er i `.gitignore`, så prosjektmodeller havner aldri i det offentlige repoet.

Det falske API-et ligger i `dev/mock-api.js`, og det brukes også av `dev/fake-viewer.html`. Den spiller StreamBIM i embedded-modus, slik at `streambim-host.html` kan testes uten innlogging: `streambim-host.html?viewer=fake-viewer.html`.

Mocken kan bare vise at widgeten oppfører seg riktig *gitt våre antagelser* om StreamBIM. Den første testen i et ekte StreamBIM-prosjekt er fortsatt fasiten.
