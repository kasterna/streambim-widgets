# StreamBIM-widgets

Samlemappe for egne StreamBIM-widgets. En StreamBIM-widget er en vanlig nettside som StreamBIM viser i en iframe i sidepanelet. **StreamBIM trenger bare et widget-navn og en URL.** Alle widgetene her hostes på GitHub Pages fra dette repoet.

## Widgets

| Navn (til StreamBIM) | URL | Status |
|---|---|---|
| **Søk Armering** | `https://kasterna.github.io/streambim-widgets/sok-armering/index.html` | Testet mot lokal mock. Ikke testet i ekte StreamBIM ennå |

### Søk Armering

Lister all armering i modellen gruppert per posisjonsnummer:

- Kolonnene er postnr, antall, diameter, lengde, formkode og segment. Klikk på en overskrift for å sortere.
- **Liste → modell:** klikk en rad, så highlightes alle stenger med det postnummeret og kameraet zoomer til gruppen.
- **Modell → liste:** klikk en stang i 3D, så utvides valget til alle stenger med samme postnr og raden flyttes øverst.
- Lista lastes automatisk når widgeten åpnes. «Oppdater liste» henter den på nytt.
- Både Tekla-navn (`Posisjonsnummer`, `Diameter jern` …) og RIB-navn (`ARM.07 - Posnr`, `ARM.08 - Stangdiameter` …) støttes samtidig.
- **Feilsøking: inspiser valgt element** nederst viser hvilke egenskapsnavn widgeten fant på sist klikkede element, pluss hele svaret fra StreamBIM. Bruk den ved første test i et ekte prosjekt.

Kjente begrensninger:

- Den viser armering i **hele modellen**, ikke bare det som er synlig. StreamBIM har ikke noe filter for «kun synlige».
- Zoom til hele gruppen skjer via et aktivt søk på postnr-egenskapen. Har andre objekter samme postnr-verdi (f.eks. betongdeler fra Tekla), kommer de med i innrammingen. Støtter ikke StreamBIM søket, zoomes det til første stang i stedet.

## Få en widget inn i StreamBIM

1. Publiser repoet på GitHub Pages (se under) og sjekk at URL-en åpner seg i nettleseren. Den skal vise «Åpnet utenfor StreamBIM ✘», og det er riktig.
2. Send **navn + URL** fra tabellen over til Rendra (support@rendra.io), med hvilket prosjekt widgeten skal slås på i. Widgets whitelistes og aktiveres per prosjekt.
3. Første test i prosjektet: åpne widgeten, klikk et armeringselement og åpne «Feilsøking». Står `feltkobling` på `IKKE FUNNET`, legg det egentlige egenskapsnavnet til i `FIELDS` i [sok-armering/rebar-lib.js](sok-armering/rebar-lib.js).

### Publisering (GitHub Pages)

Første gang:

1. GitHub Desktop: *File → Add local repository* → velg mappa med repoet → *Publish repository*. Gi repoet navnet **`streambim-widgets`**, fjern haken for *Keep this code private* og publiser under `kasterna`.
2. På github.com: *Settings → Pages* → *Deploy from a branch* → `main` / `(root)`.
3. Vent ca. ett minutt, og åpne URL-en fra tabellen.

Endringer senere: commit og push i GitHub Desktop, og vent ca. ett minutt. StreamBIM laster siden på nytt fra URL-en, så det trengs ingen ny registrering. Repoet må være **offentlig** for gratis GitHub Pages. Det er greit, for det ligger ingen hemmeligheter her.

## Lage en ny widget

1. Lag en ny mappe på toppnivå, f.eks. `min-widget/`, med `index.html`.
2. Last API-et med `<script src="../vendor/streambim-widget-api.min.js"></script>` og koble til med `StreamBIM.connectToParent(window.parent, {...})`. Bruk [sok-armering/app.js](sok-armering/app.js) som mal (`main()` har vakthund og feilmeldinger).
3. Legg ren logikk (uten DOM og uten StreamBIM) i en egen fil og test den med `node --test`, som `rebar-lib.js`.
4. Test lokalt mot mocken: `http://localhost:8084/dev/mock-host.html?widget=../min-widget/index.html`. Utvid `dev/mock-host.js` med de API-metodene widgeten bruker.
5. Legg widgeten inn i tabellen over og på [index.html](index.html), og send navn + URL til Rendra.

API-referanse og fallgruver står i [docs/streambim-widget-api.md](docs/streambim-widget-api.md).

## Lokal utvikling

```bash
npm install
npm run dev     # http-server på http://localhost:8084
npm test        # enhetstester (node --test)
```

Åpne `http://localhost:8084/dev/mock-host.html` for å kjøre widgeten mot den falske StreamBIM-verten. Etter oppgradering av `streambim-widget-api` kjører du `npm run vendor` for å kopiere ny `dist`-fil inn i `vendor/`.

## Struktur

```
index.html                 – landingsside på GitHub Pages (liste over widgets)
vendor/                    – streambim-widget-api.min.js, delt av alle widgets
sok-armering/              – Søk Armering-widgeten (index.html, app.js, rebar-lib.js, icon.svg)
dev/                       – mock-host.html/js + mock-model.js: lokal StreamBIM-etterligning
test/                      – enhetstester for ren logikk
docs/                      – API-notater og fallgruver
```
