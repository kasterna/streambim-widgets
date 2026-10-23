# StreamBIM-widgets

Samlemappe for egne StreamBIM-widgets. En StreamBIM-widget er en vanlig nettside som StreamBIM viser i en iframe i sidepanelet. **StreamBIM trenger bare et widget-navn og en URL.** Alle widgetene her hostes på GitHub Pages fra dette repoet.

## Widgets

| Navn (til StreamBIM) | URL | Status |
|---|---|---|
| **Søk Armering** | `https://kasterna.github.io/streambim-widgets/sok-armering/index.html` | Testet mot lokal mock. Ikke testet i ekte StreamBIM ennå |

### Søk Armering

Lister all armering i modellen gruppert per posisjonsnummer:

- Kolonnene er postnr, antall, diameter, lengde, formkode og segment. Klikk på en overskrift for å sortere.
- **Antall** er antall stenger. Revit eksporterer et helt armeringssett som ett IFC-objekt, så widgeten summerer egenskapen `Antall` og teller 1 per objekt der den mangler.
- **Liste → modell:** klikk en rad. Kameraet zoomer til alle stenger med det postnummeret, og de highlightes.
  - Med **Ton ned resten av modellen ved valg** (på som standard) tones resten av modellen ned, så de valgte stengene synes godt. Valget huskes i nettleseren.
  - Klikk på valgt rad igjen for å nullstille.
- **Modell → liste:** klikk en stang i 3D, så utvides valget til alle stenger med samme postnr og raden flyttes øverst.
- Lista lastes automatisk når widgeten åpnes. «Oppdater liste» henter den på nytt.
- Tekla-navn (`Posisjonsnummer`, `Diameter jern` …), RIB-navn (`ARM.07 - Posnr`, `ARM.08 - Stangdiameter` …) og Revit-eksport (`Posisjonsnummer`, `Diameter`, `Antall` …) støttes samtidig.
- **Feilsøking: inspiser valgt element** nederst viser hvilke egenskapsnavn widgeten fant på sist klikkede element, pluss hele svaret fra StreamBIM.
  - **Kopier rådata og logg** kopierer alt i én operasjon.
  - **Test søk** måler hvilke StreamBIM-søk som faktisk filtrerer, med postnummeret som er valgt.

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

Endringer senere: øk versjonen i `?v=` på skript-taggene nederst i widgetens `index.html` (f.eks. `2026-10-23.4`). Commit og push i GitHub Desktop, og vent ca. ett minutt. StreamBIM laster siden fra URL-en hver gang, så det trengs ingen ny registrering.

**Hurtigbuffer:** GitHub Pages lar nettleseren bruke gamle filer i opptil **10 minutter**. Ser du fortsatt gammel versjon (versjonsnummeret står nederst til høyre i widgeten), kan du gjøre ett av to:
- Vent 10 minutter og last StreamBIM på nytt.
- Trykk F12 → *Network* → huk av *Disable cache* → F5. Repoet må være **offentlig** for gratis GitHub Pages. Det er greit, for det ligger ingen hemmeligheter her.

## Teste mot ekte StreamBIM før widgeten er aktivert

`dev/streambim-host.html` åpner ditt StreamBIM-prosjekt i StreamBIM sin *embedded*-modus og kobler widgeten til det. Da kan du teste mot ekte modeller uten å vente på Rendra.

1. Start den lokale serveren med `npm run dev`.
2. Åpne `http://localhost:8084/dev/streambim-host.html` i **Chrome**, der du er logget inn i StreamBIM. Inni rammen i Claude-appens nettleser fikk ikke StreamBIM startet 3D.
3. Lim inn URL-en fra adressefeltet når modellen er åpen i StreamBIM, la **Eget vindu** stå valgt, og trykk **Koble til**.
4. StreamBIM åpnes i et eget vindu, med din vanlige innlogging. Ber den deg logge inn, gjør det og trykk **Koble til** igjen.
5. Widgeten til venstre jobber nå mot den ekte modellen. Klikk i StreamBIM-vinduet for å teste modell → liste.
   - Loggen nederst viser hvert kall og svar mellom widgeten og StreamBIM.
   - **Utforsk API-et** henter etasjer, lag og kamera.

Valget **I ramme** viser StreamBIM inni siden, men da deler ikke nettleseren innloggingen din med StreamBIM.

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

### Egen armeringsmodell i prøvebenken

Prøvebenken kan vise en ekte armeringsmodell i 3D. Klikk på stenger og se highlight og zoom fra widgeten. Lag testmodellen fra IFC-filene med Python og ifcopenshell:

```bash
python tools/ifc-til-testmodell.py "sti/til/ARM.ifc" --kontekst "sti/til/KON.ifc" --navn mitt-prosjekt
```

Den legges i `dev/models/` og velges automatisk i prøvebenken. Hvis du har flere modeller, bytter du i **Modell**-menyen. `dev/models/` er i `.gitignore`, så prosjektmodeller blir aldri publisert.

## Struktur

```
index.html                 – landingsside på GitHub Pages (liste over widgets)
vendor/                    – streambim-widget-api.min.js, delt av alle widgets
sok-armering/              – Søk Armering-widgeten (index.html, app.js, rebar-lib.js, icon.svg)
dev/                       – mock-host.html: widget mot falsk StreamBIM (prøvebenk)
                             streambim-host.html: widget mot ekte StreamBIM (embedded-modus)
                             fake-viewer.html: falsk StreamBIM for å teste streambim-host
                             mock-api.js + mock-model.js: felles falskt API og testdata
                             model-view.js: 3D-visning av testmodeller (three.js)
                             models/: testmodeller laget fra IFC (lokalt, ikke i git)
tools/                     – ifc-til-testmodell.py: IFC → testmodell for prøvebenken
test/                      – enhetstester for ren logikk
docs/                      – API-notater og fallgruver
```
