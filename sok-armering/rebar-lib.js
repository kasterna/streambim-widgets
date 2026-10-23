/* Rene hjelpefunksjoner for Søk Armering — ingen DOM og ingen StreamBIM-kall, slik at de
 * kan enhetstestes med `node --test`. Lastes som vanlig <script> i nettleseren (blir
 * window.RebarLib) og som CommonJS-modul i testene. */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.RebarLib = lib;
})(typeof self !== "undefined" ? self : this, function () {
  /** Kandidat-navn per kolonne, prøvd i rekkefølge — første treff vinner. Tekla- og
   *  RIB-navnene er bekreftet mot ekte modeller, men ikke i StreamBIM ennå — StreamBIM kan
   *  eksponere dem annerledes. Bruk "Feilsøking" i widgeten og LEGG TIL nye navn her (ikke
   *  endre eksisterende — andre prosjekter er avhengige av dem). */
  const FIELDS = {
    postnr: ["Posisjonsnummer", "ARM.07 - Posnr"],
    diameter: ["Diameter jern", "ARM.08 - Stangdiameter"],
    lengde: ["Armeringslengde", "ARM.80 - Kapplengde"], // ikke ARM.81 - Totallengde (sum for gruppen)
    formkode: ["Formkode", "ARM.37 - Formkode"],
    segment: ["Segment"],
  };

  /** Søkene som til sammen definerer "armering" i modellen (unionen av alle treff), altså
   *  "IFC-klasse ELLER Common Type". `@kind` er StreamBIM sin
   *  IFC-klasse uten "Ifc"-prefiks (demoen bruker '@kind' = 'Door'/'Space'); prefiks-
   *  variantene er med i tilfelle. UVERIFISERT mot ekte StreamBIM-modell med armering. */
  const REBAR_SEARCHES = [
    { label: "IFC-klasse (@kind)", key: "@kind", values: ["ReinforcingBar", "ReinforcingMesh", "IfcReinforcingBar", "IfcReinforcingMesh"] },
    { label: "Common Type", key: "Common Type", values: ["REINFORCINGBAR", "REINFORCINGMESH"] },
  ];

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

  /** Finner første kandidat-navn som har en verdi. Returnerer {key, name, value} — `key`
   *  er hele nøkkelen slik StreamBIM leverte den, `name` er selve egenskapsnavnet (brukes
   *  som søkenøkkel). Eksakt treff prøves for alle kandidater før store/små bokstaver
   *  ignoreres, slik at kandidat-rekkefølgen alltid styrer. */
  function findProperty(properties, names) {
    const entries = flattenProperties(properties).filter((e) => hasValue(e.value));
    const nameList = Array.isArray(names) ? names : [names];

    for (const name of nameList) {
      const hit = entries.find((e) => e.key === name || e.name === name);
      if (hit) return hit;
    }
    for (const name of nameList) {
      const lower = name.toLowerCase();
      const hit = entries.find((e) => e.key.toLowerCase() === lower || e.name.toLowerCase() === lower);
      if (hit) return hit;
    }
    return undefined;
  }

  function valueOf(hit) {
    return hit ? hit.value : undefined;
  }

  /** Grupperer [{guid, properties}] per posisjonsnummer. Diameter/lengde/formkode/segment
   *  tas fra første stang i gruppen (kjent begrensning: avvikende verdier innen samme
   *  postnr vises ikke). */
  function groupRebar(items) {
    const groups = new Map();
    let missingPostnr = 0;

    for (const { guid, properties } of items) {
      const postnrHit = findProperty(properties, FIELDS.postnr);
      const key = postnrHit ? String(postnrHit.value) : MISSING_POSTNR;
      if (!postnrHit) missingPostnr++;

      if (!groups.has(key)) {
        groups.set(key, {
          postnr: key,
          searchKey: postnrHit ? postnrHit.name : null,
          diameter: valueOf(findProperty(properties, FIELDS.diameter)),
          lengde: valueOf(findProperty(properties, FIELDS.lengde)),
          formkode: valueOf(findProperty(properties, FIELDS.formkode)),
          segment: valueOf(findProperty(properties, FIELDS.segment)),
          guids: [],
        });
      }
      groups.get(key).guids.push(guid);
    }

    const rows = Array.from(groups.values()).map((row) => ({ ...row, count: row.guids.length }));
    return { rows, missingPostnr };
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
    REBAR_SEARCHES,
    MISSING_POSTNR,
    flattenProperties,
    findProperty,
    groupRebar,
    sortRows,
    formatLengde,
    moveToTop,
    mapWithConcurrency,
  };
});
