/* Rene hjelpefunksjoner for Søk Armering — ingen DOM og ingen StreamBIM-kall, slik at de
 * kan enhetstestes med `node --test`. Lastes som vanlig <script> i nettleseren (blir
 * window.RebarLib) og som CommonJS-modul i testene. */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.RebarLib = lib;
})(typeof self !== "undefined" ? self : this, function () {
  /** Kandidat-navn per kolonne, prøvd i rekkefølge — første treff vinner. Navnene fra
   *  Revit-eksporten (Posisjonsnummer, Diameter, Armeringslengde, Formkode, Antall) er
   *  bekreftet i ekte StreamBIM; Tekla- og RIB-navnene er bekreftet i andre verktøy. Bruk
   *  "Feilsøking" i widgeten og LEGG TIL nye navn her (ikke endre eksisterende — andre
   *  prosjekter er avhengige av dem). */
  const FIELDS = {
    // De regulære uttrykkene tar eksporter med kode foran navnet (pset MERKNADER: "K200 Pos
    // nr", "K201 Stangdiameter" …), lest av et skjermbilde fra StreamBIM.
    postnr: ["Posisjonsnummer", "ARM.07 - Posnr", /^K\d+\s+Pos\.?\s*nr\b/i],
    diameter: ["Diameter jern", "ARM.08 - Stangdiameter", "Diameter", /^K\d+\s+Stangdiameter\b/i],
    lengde: ["Armeringslengde", "ARM.80 - Kapplengde", /^K\d+\s+Kapplengde\b/i], // ikke ARM.81 - Totallengde (sum for gruppen)
    formkode: ["Formkode", "ARM.37 - Formkode", /^K\d+\s+Formkode\b/i],
    segment: ["Segment"],
    // Antall stenger i objektet. Revit eksporterer et helt armeringssett som ÉTT IFC-objekt
    // (f.eks. 38 bøyler), så å telle objekter gir for lavt antall.
    antall: ["Antall", /^K\d+\s+Antall\b/i],
  };

  /** @kind-verdiene armeringen søkes opp med. StreamBIM lager @kind fra IFC-klassen som
   *  lesbar tekst ("Reinforcing bar"), uansett hvilket program som eksporterte (bekreftet
   *  for både Revit-eksport og eksport med kodede navn). */
  const REBAR_KINDS = ["Reinforcing bar", "Reinforcing mesh"];
  /** En @kind som ikke finnes. Svaret på den viser hvordan «søket filtrerte ikke» ser ut. */
  const UNKNOWN_KIND = "Sok Armering finnes ikke";

  const MISSING_POSTNR = "(mangler postnr)";

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasValue(value) {
    return value !== undefined && value !== null && value !== "";
  }

  /** Gjør om getObjectInfo().properties til en flat liste {key, name, value}. Dekker de
   *  formene StreamBIM kan tenkes å bruke, siden ObjectInfo ikke er dokumentert:
   *  flate navn ("Posisjonsnummer"), "Pset~Egenskap"-nøkler (samme notasjon som
   *  valuesForObjectProperty) og nestede Pset-objekter. Array-verdier (som demoens
   *  properties['System Global Id'][0]) normaliseres til første element. */
  function flattenProperties(properties, prefix) {
    if (!isPlainObject(properties)) return [];
    return Object.entries(properties).flatMap(([rawKey, raw]) => {
      const key = prefix ? `${prefix}~${rawKey}` : rawKey;
      if (isPlainObject(raw)) return flattenProperties(raw, key);
      const name = rawKey.split("~").pop().trim();
      return [{ key, name, value: Array.isArray(raw) ? raw[0] : raw }];
    });
  }

  /** Passer kandidaten til egenskapen? En streng må være lik hele nøkkelen eller bare
   *  navnet. Et regulært uttrykk testes mot navnet alene (aldri mot Pset-navnet), og
   *  lastIndex nullstilles så et uttrykk med g-flagg gir samme svar hver gang. */
  function candidateMatches(candidate, entry) {
    if (candidate instanceof RegExp) {
      candidate.lastIndex = 0;
      return candidate.test(entry.name);
    }
    return entry.key === candidate || entry.name === candidate;
  }

  /** Finner første kandidat som har en verdi. En kandidat er et navn (streng) eller et
   *  regulært uttrykk — uttrykk trengs der eksporten setter kode foran navnet ("K200 Pos
   *  nr"). Returnerer {key, name, value}: `key` er hele nøkkelen slik StreamBIM leverte
   *  den, `name` er selve egenskapsnavnet (brukes som søkenøkkel). Eksakte treff og
   *  uttrykk prøves for alle kandidater i rekkefølge før store/små bokstaver ignoreres
   *  for strenger, slik at kandidat-rekkefølgen alltid styrer. */
  function findProperty(properties, names) {
    const entries = flattenProperties(properties).filter((e) => hasValue(e.value));
    const candidates = Array.isArray(names) ? names : [names];

    for (const candidate of candidates) {
      const hit = entries.find((e) => candidateMatches(candidate, e));
      if (hit) return hit;
    }
    for (const candidate of candidates.filter((c) => typeof c === "string")) {
      const lower = candidate.toLowerCase();
      const hit = entries.find((e) => e.key.toLowerCase() === lower || e.name.toLowerCase() === lower);
      if (hit) return hit;
    }
    return undefined;
  }

  function valueOf(hit) {
    return hit ? hit.value : undefined;
  }

  /** Samler et getObjectInfo()-svar til ett egenskapsobjekt for findProperty. Ekte
   *  StreamBIM legger IFC-attributter (Name, @kind …) i `properties`, men alle Pset-
   *  egenskaper i `groups[]` som {label: Pset, content: {properties: [{key, value}]}}.
   *  Gruppene blir nestede Pset-objekter, slik at nøklene blir "Pset~Egenskap". */
  function objectProperties(info) {
    if (!info) return {};
    const base = isPlainObject(info.properties) ? info.properties : {};
    if (!Array.isArray(info.groups)) return base;

    const psets = {};
    for (const group of info.groups) {
      const props = group && group.content && group.content.properties;
      if (!group.label || !Array.isArray(props)) continue;
      psets[group.label] = Object.fromEntries(props.filter((p) => p && p.key).map((p) => [p.key, p.value]));
    }
    return { ...base, ...psets };
  }

  /** @kind sier hva objektet er ("Reinforcing bar", "Reinforcing mesh" i ekte StreamBIM).
   *  Mangler @kind, beholdes objektet — da var søket den eneste kilden vi har. */
  function isRebarObject(properties) {
    const kind = properties && properties["@kind"];
    return !hasValue(kind) || /reinforc/i.test(String(kind));
  }

  /** Har StreamBIM laget 3D for objektet? Ekte getObjectInfo har en "Geometry"-gruppe med
   *  "Faces Hi"/"Faces Lo". true = har flater, false = alle er 0 (objektet finnes i data,
   *  men vises ikke i 3D — f.eks. etter en mangelfull import), null = ukjent. */
  function hasGeometry(properties) {
    const geometry = properties && properties.Geometry;
    if (!isPlainObject(geometry)) return null;
    const faces = ["Faces Hi", "Faces Lo"].map((key) => Number(geometry[key])).filter((n) => hasValue(n) && Number.isFinite(n));
    if (faces.length === 0) return null;
    return faces.some((n) => n > 0);
  }

  /** Stenger i ett IFC-objekt: Antall-egenskapen når den er et positivt tall, ellers 1. */
  function barsIn(properties) {
    const antall = Number(valueOf(findProperty(properties, FIELDS.antall)));
    return Number.isFinite(antall) && antall > 0 ? antall : 1;
  }

  /** Grupperer [{guid, properties, building}] per posisjonsnummer. `count` er antall
   *  stenger (sum av Antall), `objects` antall IFC-objekter. `building` er reserve for
   *  søkeregelen når getBuildingId() ikke svarer. Diameter/lengde/formkode/segment
   *  tas fra første objekt i gruppen (kjent begrensning: avvikende verdier innen samme
   *  postnr vises ikke). */
  function groupRebar(items) {
    const groups = new Map();
    let missingPostnr = 0;
    let missing3d = 0;

    for (const { guid, properties, building } of items) {
      const postnrHit = findProperty(properties, FIELDS.postnr);
      const key = postnrHit ? String(postnrHit.value) : MISSING_POSTNR;
      if (!postnrHit) missingPostnr++;

      if (!groups.has(key)) {
        groups.set(key, {
          postnr: key,
          building,
          diameter: valueOf(findProperty(properties, FIELDS.diameter)),
          lengde: valueOf(findProperty(properties, FIELDS.lengde)),
          formkode: valueOf(findProperty(properties, FIELDS.formkode)),
          segment: valueOf(findProperty(properties, FIELDS.segment)),
          count: 0,
          missing3d: 0,
          guids: [],
        });
      }
      const group = groups.get(key);
      group.count += barsIn(properties);
      group.guids.push(guid);
      if (hasGeometry(properties) === false) {
        group.missing3d++;
        missing3d++;
      }
    }

    const rows = Array.from(groups.values()).map((row) => ({ ...row, objects: row.guids.length }));
    return { rows, missingPostnr, missing3d };
  }

  /** Regel for «nettopp disse objektene», i formatet StreamBIM selv bruker: findObjects og
   *  applyObjectSearch tar `{rules: [[regel]]}` på toppnivå. Flere objekter: «@guid in a|b|c»,
   *  som StreamBIM bygger i colorCodeObjects. ÉTT objekt: vanlig likhet uten operator, for «in»
   *  med bare én verdi fant ingenting live (0 av 1 objekter for hver enkeltobjekt-gruppe, mens
   *  2+ ga N/N). Likhet er formen StreamBIM bruker for rom (searchForSpaces). */
  function guidSearchRule(guids, buildingId) {
    const base = { ...(buildingId ? { buildingId } : {}), propKey: "@guid" };
    if (guids.length === 1) return { ...base, propValue: guids[0] };
    return { ...base, operator: "in", propValue: guids.join("|") };
  }

  /** Har de to listene nøyaktig de samme GUID-ene (rekkefølgen spiller ingen rolle)? */
  function sameGuidSet(a, b) {
    const set = new Set(a);
    return set.size === new Set(b).size && b.every((guid) => set.has(guid));
  }

  /** Velger kandidatene til armering ut fra ett findObjects-svar per @kind-verdi
   *  (`hitsByKind`, {kind: guid[]}, null = søket feilet). StreamBIM gir ALT (opp til limit)
   *  for en verdi som ikke finnes i modellen: live ga «Reinforcing bar» 2125 av 3624 objekter,
   *  «Reinforcing mesh» alle 3624. Et svar med nøyaktig de samme objektene som for
   *  UNKNOWN_KIND (`unknownHits`) filtrerte altså ikke, og hoppes over. Filtrerte ingen,
   *  brukes alt; @kind sjekkes uansett per objekt etterpå (isRebarObject). Returnerer
   *  {guids, kinds}, der `kinds` er @kind-verdiene som filtrerte. */
  function rebarCandidates(hitsByKind, unknownHits) {
    const filtered = Object.entries(hitsByKind).filter(
      ([, hits]) => Array.isArray(hits) && !sameGuidSet(hits, unknownHits || [])
    );
    const sources = filtered.length ? filtered.map(([, hits]) => hits) : [unknownHits || []];
    return { guids: [...new Set(sources.flat())], kinds: filtered.map(([kind]) => kind) };
  }

  /** Søkefeltet: radene der postnr inneholder teksten, uten forskjell på store og små
   *  bokstaver. Tom tekst gir alle radene. */
  function filterRows(rows, query) {
    const wanted = String(query ?? "").trim().toLowerCase();
    if (!wanted) return rows;
    return rows.filter((row) => String(row.postnr).toLowerCase().includes(wanted));
  }

  /** Gjør om svaret fra getObjectInfoForSearch til [{guid, properties}]. StreamBIM svarer med
   *  sin søkeeksport (/ifc-searches/export/json, lest i StreamBIM sin kode):
   *  {header: [{id}], data: [{GUID, "Pset~Egenskap": verdi, …}]}. "Pset~Egenskap"-feltene
   *  blir nestede Pset-objekter, slik objectProperties lager dem av getObjectInfo, så
   *  findProperty og hasGeometry leser begge likt. Rader uten GUID droppes. */
  function exportItems(response) {
    const data = response && Array.isArray(response.data) ? response.data : [];
    return data.filter((row) => isPlainObject(row) && hasValue(row.GUID)).map((row) => {
      const properties = {};
      for (const [key, value] of Object.entries(row)) {
        const split = key.indexOf("~");
        if (split < 0) {
          properties[key] = value;
          continue;
        }
        const pset = key.slice(0, split);
        if (!isPlainObject(properties[pset])) properties[pset] = {};
        properties[pset][key.slice(split + 1)] = value;
      }
      return { guid: String(row.GUID), properties };
    });
  }

  /** Stikkprøvene som sjekkes mot getObjectInfo: første objekt for hver måte postnr er
   *  navngitt på (én per eksport/modell, pluss dem uten postnr), og det midterste og siste. */
  function exportSamples(items) {
    const MAX_SAMPLES = 6;
    const byScheme = new Map();
    for (const item of items) {
      const hit = findProperty(item.properties, FIELDS.postnr);
      const scheme = hit ? hit.key : null;
      if (!byScheme.has(scheme)) byScheme.set(scheme, item);
    }
    const picks = [...byScheme.values(), items[Math.floor(items.length / 2)], items[items.length - 1]];
    return [...new Set(picks.filter(Boolean))].slice(0, MAX_SAMPLES);
  }

  function sameValue(a, b) {
    if (String(a) === String(b)) return true;
    const [na, nb] = [Number(a), Number(b)];
    return hasValue(a) && hasValue(b) && Number.isFinite(na) && na === nb;
  }

  /** Kolonnene der eksporten mangler en verdi som getObjectInfo har, eller har en annen
   *  verdi, pluss "3D-geometri" hvis bare getObjectInfo vet om objektet har 3D. Tom liste =
   *  eksporten kan brukes. Eksporten kan ha færre felt enn getObjectInfo (antallet felt kan
   *  være begrenset), og det er ikke dokumentert. */
  function exportGaps(exportProperties, infoProperties) {
    const gaps = Object.keys(FIELDS).filter((field) => {
      const expected = findProperty(infoProperties, FIELDS[field]);
      if (!expected) return false;
      const actual = findProperty(exportProperties, FIELDS[field]);
      return !actual || !sameValue(actual.value, expected.value);
    });
    const geometry = hasGeometry(infoProperties);
    if (geometry !== null && hasGeometry(exportProperties) !== geometry) gaps.push("3D-geometri");
    return gaps;
  }

  /** Returnerer en ny sortert liste. Tall sorteres numerisk, resten alfabetisk; tomme
   *  verdier havner sist ved stigende sortering. "(mangler postnr)"-gruppen ligger alltid
   *  nederst, uansett kolonne og retning. */
  function sortRows(rows, key, dir) {
    return [...rows].sort((a, b) => {
      const aMissing = a.postnr === MISSING_POSTNR;
      const bMissing = b.postnr === MISSING_POSTNR;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;

      const av = a[key];
      const bv = b[key];
      if (!hasValue(av) || !hasValue(bv)) {
        return (hasValue(av) ? -1 : hasValue(bv) ? 1 : 0) * dir;
      }
      const an = parseFloat(av);
      const bn = parseFloat(bv);
      if (!isNaN(an) && !isNaN(bn) && an !== bn) return (an - bn) * dir;
      return String(av).localeCompare(String(bv), "nb", { numeric: true }) * dir;
    });
  }

  /** Lengde kommer i mm og har for RIB-modeller mange desimaler (f.eks.
   *  2647.1150383789704) — rund av til nærmeste hele mm for visning. */
  function formatLengde(value) {
    if (!hasValue(value)) return "";
    const n = Number(value);
    return isNaN(n) ? String(value) : String(Math.round(n));
  }

  /** Flytter første rad som matcher `predicate` øverst. Returnerer {rows, row} med en ny
   *  liste, eller null hvis ingen rad matcher. */
  function moveToTop(rows, predicate) {
    const index = rows.findIndex(predicate);
    if (index === -1) return null;
    const row = rows[index];
    return { rows: [row, ...rows.slice(0, index), ...rows.slice(index + 1)], row };
  }

  /** Kjører `fn` over `items` med maks `limit` samtidige kall (så vi ikke fyrer av
   *  hundrevis av getObjectInfo()-kall på en gang). Resultatene beholder rekkefølgen.
   *  `onProgress(ferdige, totalt)` kalles etter hvert fullførte element. */
  async function mapWithConcurrency(items, limit, fn, onProgress) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let done = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const current = nextIndex++;
        results[current] = await fn(items[current], current);
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  return {
    FIELDS,
    REBAR_KINDS,
    UNKNOWN_KIND,
    MISSING_POSTNR,
    flattenProperties,
    findProperty,
    objectProperties,
    isRebarObject,
    groupRebar,
    hasGeometry,
    guidSearchRule,
    rebarCandidates,
    sameGuidSet,
    filterRows,
    exportItems,
    exportSamples,
    exportGaps,
    sortRows,
    formatLengde,
    moveToTop,
    mapWithConcurrency,
  };
});
