const {
  FIELDS,
  REBAR_KINDS,
  UNKNOWN_KIND,
  findProperty,
  objectProperties,
  isRebarObject,
  groupRebar,
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
} = window.RebarLib;

// Versjonen står bare ett sted: ?v= på skript-taggene i index.html.
const WIDGET_VERSION = new URL(document.currentScript.src).searchParams.get("v") || "ukjent";

const SEARCH_LIMIT = 10000;
const INFO_CONCURRENCY = 10;
const CONNECT_TIMEOUT_MS = 15000;
const COLUMNS = ["postnr", "count", "objects", "diameter", "lengde", "formkode", "segment"];

const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh-btn");
const countEl = document.getElementById("count");
const restModeSelect = document.getElementById("rest-mode");
const filterInput = document.getElementById("postnr-filter");
const filterCountEl = document.getElementById("filter-count");
const noteEl = document.getElementById("note");
const tableContainer = document.getElementById("table-container");
const tableBody = document.querySelector("#rebar-table tbody");
const headerCells = document.querySelectorAll("#rebar-table th[data-key]");
const debugToggle = document.getElementById("debug-toggle");
const debugPanel = document.getElementById("debug-panel");
const debugOutput = document.getElementById("debug-output");
const logEl = document.getElementById("log");
const copyBtn = document.getElementById("copy-btn");

let rows = []; // grouped rebar rows currently shown
let sortKey = "postnr";
let sortDir = 1;
let selectedKey = null; // postnr of the highlighted row
let lastPickedGuid = null;
let hasLoaded = false;
let buildingId = null; // fra getBuildingId() — samme verdi StreamBIM bruker i egne søkeregler
let listNote = ""; // meldingen fra sist lasting, vises igjen når en markering går bra
// Nytt navn (var "sok-armering-ton-ned" med 1/0): en tidligere "av" skal ikke ta bort nedtoningen.
const REST_STORAGE_KEY = "sok-armering-resten";
const REST_MODES = ["FADED", "HIDDEN", "ORIGINAL"]; // StreamBIM sine visningsmoduser utenfor søket

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.value += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

/** StreamBIM avviser med {code, debug} (README sier {code, detail}), penpal med Error. */
function errText(err) {
  if (!err) return "ukjent feil";
  return err.code || err.message || JSON.stringify(err);
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

function showNote(text) {
  noteEl.textContent = text;
  noteEl.classList.toggle("show", Boolean(text));
}

/** Finner kandidatene til armering: ett findObjects-søk per @kind-verdi, pluss ett på en
 *  verdi som ikke finnes, for å kjenne igjen søk som ikke filtrerer (rebarCandidates). Da
 *  hentes info bare for armeringen, ikke for hver vegg og plate i bygningen. Treffene
 *  logges, så det synes hvordan StreamBIM svarte. Returnerer {guids, kinds}. */
async function findRebarCandidates() {
  const find = (value) =>
    StreamBIM.API.findObjects({ key: "@kind", value, limit: SEARCH_LIMIT }).then(
      (hits) => hits || [],
      (err) => {
        log(`Søk på @kind "${value}" feilet: ${errText(err)}`);
        return null;
      }
    );
  const unknownHits = await find(UNKNOWN_KIND);
  const hitsByKind = {};
  for (const kind of REBAR_KINDS) hitsByKind[kind] = await find(kind);

  const candidates = rebarCandidates(hitsByKind, unknownHits);
  const counts = REBAR_KINDS.map((kind) => `"${kind}"=${hitsByKind[kind] ? hitsByKind[kind].length : "feil"}`);
  log(`Søk på @kind: ${counts.join(", ")}, ukjent verdi=${unknownHits ? unknownHits.length : "feil"}. ${candidates.guids.length} objekter å hente.`);
  return candidates;
}

/** Rask henting: ett getObjectInfoForSearch-kall per @kind som filtrerte, i stedet for ett
 *  getObjectInfo-kall per objekt. Svaret er StreamBIM sin søkeeksport, og formatet er ikke
 *  dokumentert, så det kontrolleres før det brukes: nøyaktig de samme objektene som søket,
 *  og stikkprøver mot getObjectInfo for hver kolonne. Returnerer items, eller null når den
 *  vanlige hentingen per objekt må brukes (grunnen logges). */
async function fetchRebarViaExport(kinds, guids) {
  if (kinds.length === 0) return null; // ingen søk filtrerte, så eksporten ville gitt alt
  try {
    setStatus("Henter egenskaper for alle objektene i ett kall...", "busy");
    const byGuid = new Map();
    for (const kind of kinds) {
      const response = await StreamBIM.API.getObjectInfoForSearch({
        filter: { key: "@kind", value: kind },
        page: { limit: SEARCH_LIMIT, skip: 0 },
        fieldUnion: true, // alle egenskaper, ikke bare dem alle objektene har felles
      });
      exportItems(response).forEach((item) => byGuid.set(item.guid, item));
    }
    const items = [...byGuid.values()];
    if (!sameGuidSet(items.map((item) => item.guid), guids)) {
      log(`Hurtighenting ga ${items.length} objekter, søket ${guids.length}. Henter per objekt i stedet.`);
      return null;
    }
    for (const sample of exportSamples(items)) {
      const gaps = exportGaps(sample.properties, objectProperties(await StreamBIM.API.getObjectInfo(sample.guid)));
      if (gaps.length) {
        log(`Hurtighentingen mangler ${gaps.join(", ")} (stikkprøve ${sample.guid}). Henter per objekt i stedet.`);
        return null;
      }
    }
    return items.map((item) => ({ ...item, building: buildingId }));
  } catch (err) {
    log(`Hurtighenting feilet (${errText(err)}). Henter per objekt i stedet.`);
    return null;
  }
}

/** Henter info per objekt og beholder bare armering (@kind). Filtrerte ingen av søkene, er
 *  alle objektene i bygningen med her. Egenskapene samles fra både `properties` og `groups`
 *  (objectProperties). */
async function fetchRebarInfo(guids) {
  const infos = await mapWithConcurrency(
    guids,
    INFO_CONCURRENCY,
    (guid) =>
      StreamBIM.API.getObjectInfo(guid).catch((err) => {
        log(`getObjectInfo(${guid}) feilet: ${errText(err)}`);
        return null;
      }),
    (done, total) => setStatus(`Henter egenskaper ${done}/${total}...`, "busy")
  );
  const items = infos
    .map((info, i) => (info ? { guid: guids[i], properties: objectProperties(info), building: info.building } : null))
    .filter(Boolean);
  const rebar = items.filter((item) => isRebarObject(item.properties));
  if (rebar.length < items.length) log(`${items.length - rebar.length} objekter var ikke armering (@kind) og ble utelatt.`);
  return rebar;
}

/** StreamBIM søker og zoomer i AKTIV bygning (et prosjekt kan ha flere, f.eks. én per sted).
 *  Byttes bygning etter at widgeten startet, må id-en hentes på nytt, ellers får
 *  søkeregelen feil buildingId. */
async function refreshBuildingId() {
  const previous = buildingId;
  buildingId = await StreamBIM.API.getBuildingId().catch(() => buildingId);
  if (previous === null) log(`Bygning (getBuildingId): ${buildingId ?? "ukjent — bruker bygning fra objektinfo"}`);
  else if (buildingId !== previous) log(`Aktiv bygning er endret: ${previous} → ${buildingId}.`);
}

/** Meldingen over lista etter lasting: ingen armering, manglende postnr eller manglende 3D. */
function loadNote(objectCount, missingPostnr, missing3d) {
  if (objectCount === 0) {
    return (
      `Fant ingen armering (@kind «${REBAR_KINDS.join("» eller «")}»). Klikk et armeringselement i ` +
      "3D-vieweren og åpne «Feilsøking» nederst for å se hvilke egenskaper StreamBIM har på elementet."
    );
  }
  const notes = [];
  if (missingPostnr > 0) {
    notes.push(
      `${missingPostnr} elementer manglet postnr-egenskapen. Klikk ett av dem i 3D-vieweren og ` +
      "åpne «Feilsøking» for å se hva postnr heter i denne modellen."
    );
  }
  if (missing3d > 0) {
    const affected = rows.filter((row) => row.missing3d > 0).map((row) => row.postnr);
    notes.push(
      `${missing3d} av ${objectCount} objekter har ingen 3D-geometri i StreamBIM og vises ikke i modellen ` +
      `(postnr ${affected.slice(0, 20).join(", ")}${affected.length > 20 ? " …" : ""}). ` +
      "Sjekk eksporten/importen av IFC-filen."
    );
  }
  return notes.join(" ");
}

async function fetchRebarList() {
  refreshBtn.disabled = true;
  setStatus("Søker etter armering...", "busy");
  showNote("");

  try {
    const started = performance.now();
    await refreshBuildingId();
    const { guids, kinds } = await findRebarCandidates();
    let items = [];
    if (guids.length) {
      const fast = await fetchRebarViaExport(kinds, guids);
      items = fast || (await fetchRebarInfo(guids));
      log(`${fast ? "Hurtighenting" : "Henting per objekt"}: ${((performance.now() - started) / 1000).toFixed(1)} s.`);
    }
    const { rows: grouped, missingPostnr, missing3d } = groupRebar(items);
    rows = sortRows(grouped, sortKey, sortDir);
    // Behold valget hvis gruppen fortsatt finnes, så lista stemmer med markeringen i 3D.
    if (!rows.some((row) => row.postnr === selectedKey)) selectedKey = null;
    hasLoaded = true;
    renderTable();

    const bars = rows.reduce((sum, row) => sum + row.count, 0);
    countEl.textContent =
      `${bars} stenger i ${items.length} IFC-objekter (${rows.length} unike postnr)` +
      (buildingId ? ` · bygning ${buildingId}.` : ".");
    listNote = loadNote(items.length, missingPostnr, missing3d);
    showNote(listNote);
    if (missing3d > 0) log(`${missing3d} objekter uten 3D-geometri i StreamBIM.`);
    setStatus("Tilkoblet StreamBIM ✔", "ok");
    log(`Hentet ${items.length} IFC-objekter med ${bars} stenger, ${rows.length} unike postnr.`);
  } catch (err) {
    setStatus("Feil ved henting av armering ✘", "error");
    log("Feil: " + errText(err));
  } finally {
    refreshBtn.disabled = false;
  }
}

/** Bygger cellene med textContent — verdiene kommer fra modellen og skal aldri tolkes
 *  som HTML. */
function renderTable() {
  tableBody.replaceChildren();
  const query = filterInput.value.trim();
  const visible = filterRows(rows, query);
  filterCountEl.textContent = query && rows.length ? `${visible.length} av ${rows.length}` : "";

  if (visible.length === 0) {
    const tr = document.createElement("tr");
    tr.id = "empty-row";
    const td = document.createElement("td");
    td.colSpan = COLUMNS.length;
    if (!hasLoaded) td.textContent = "Lista lastes når widgeten er koblet til StreamBIM.";
    else if (rows.length && query) td.textContent = `Ingen postnr inneholder «${query}».`;
    else td.textContent = "Ingen armering i lista.";
    tr.appendChild(td);
    tableBody.appendChild(tr);
  }

  for (const row of visible) {
    const tr = document.createElement("tr");
    if (row.postnr === selectedKey) tr.className = "selected";
    // "Obj." er IFC-objekter — samme tall som StreamBIM viser i «Fremhever N objekter».
    const objectsText = row.missing3d > 0 ? `${row.objects} (${row.missing3d} uten 3D)` : row.objects;
    const values = [row.postnr, row.count, objectsText, row.diameter, formatLengde(row.lengde), row.formkode, row.segment];
    values.forEach((value, i) => {
      const td = document.createElement("td");
      td.textContent = value ?? "";
      if (COLUMNS[i] === "objects" && row.missing3d > 0) td.className = "warn";
      tr.appendChild(td);
    });
    tr.addEventListener("click", () => (row.postnr === selectedKey ? clearSelection() : selectAndZoom(row)));
    tableBody.appendChild(tr);
  }

  headerCells.forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === sortKey);
    th.classList.toggle("desc", th.dataset.key === sortKey && sortDir === -1);
  });
}

/** Hva som skjer med resten av modellen: FADED (tones ned, standard), HIDDEN (skjules) eller
 *  ORIGINAL (vises som før). I tett, flerfarget armering er FADED/HIDDEN det som gjør
 *  markeringen synlig. */
function visualizationMode() {
  return restModeSelect.value;
}

function groupRule(row) {
  return guidSearchRule(row.guids, buildingId || row.building);
}

/** StreamBIM-kall som endrer 3D-visningen kjøres ett om gangen, i klikkrekkefølge. Kommer
 *  det et nytt klikk mens et kall venter, hoppes det ventende over: hvert kall setter hele
 *  visningen på nytt, så bare siste klikk betyr noe. Uten dette kunne et dobbeltklikk (velg +
 *  nullstill) flette kallene i hverandre, og 3D endte med markering mens lista var uten valg. */
const SKIPPED = Symbol("hoppet over");
let viewQueue = Promise.resolve();
let latestViewTask = 0;
function updateView(task) {
  const id = ++latestViewTask;
  const run = viewQueue.then(() => (id === latestViewTask ? task() : SKIPPED));
  viewQueue = run.catch(() => {});
  return run;
}

/** Markerer hele postnr-gruppen og toner ned eller skjuler resten. Rekkefølgen er bygget på
 *  StreamBIM sin egen kode (se docs, «Slik virker API-et egentlig»):
 *  1. colorCodeObjects({}) = resetIfcSearch: tømmer søk og visningsmodus. Uten dette kjørte
 *     setSearchVisualizationMode (reloadSearch) det FORRIGE søket parallelt med det nye, og
 *     bare første klikk virket (live 2026-10-23).
 *  2. FADED er standard etter reset; andre moduser settes før det nye søket.
 *  3. applyObjectSearch svarer først når søket er ferdig, så zoomToSearchResult etterpå
 *     rammer inn akkurat gruppen. Markeringen får StreamBIM sin grønne søkefarge: denne
 *     StreamBIM-versjonen ignorerer fargene i colorCodeObjects, så et vanlig søk gir det samme.
 *  Returnerer hvor mange av objektene StreamBIM fant (verifyMark). */
async function markGroup(row, { zoom }) {
  await StreamBIM.API.colorCodeObjects({});
  if (visualizationMode() !== "FADED") await StreamBIM.API.setSearchVisualizationMode(visualizationMode());
  await StreamBIM.API.applyObjectSearch({ rules: [[groupRule(row)]] });
  if (zoom) await StreamBIM.API.zoomToSearchResult();
  return verifyMark(row);
}

/** Lesende kontroll (endrer ingenting i 3D): finner StreamBIM alle objektene i gruppen med
 *  samme regel som markeringen? Svaret havner i loggen, og finner den for få, vises en
 *  melding slik at en markering som ikke tok ikke går ubemerket hen (går den bra, vises
 *  meldingen fra lastingen igjen). Returnerer antall funnet, eller null hvis kontrollen feilet. */
async function verifyMark(row) {
  try {
    const hits = await StreamBIM.API.findObjects({ rules: [[groupRule(row)]], limit: SEARCH_LIMIT });
    const found = Array.isArray(hits) ? hits.length : 0;
    showNote(
      found < row.objects
        ? `StreamBIM fant bare ${found} av ${row.objects} objekter for postnr ${row.postnr}, så markeringen er ` +
            "trolig ufullstendig. Åpne «Feilsøking» og kopier loggen."
        : listNote
    );
    return found;
  } catch (err) {
    log(`Kontroll av markering feilet: ${errText(err)}`);
    return null;
  }
}

/** Markerer gruppen i 3D og logger utfallet. `how` beskriver klikket i loggen. */
async function showGroup(row, { zoom, how }) {
  try {
    const found = await updateView(() => markGroup(row, { zoom }));
    if (found === SKIPPED) return;
    log(
      `${how} postnr ${row.postnr} (${row.count} stk i ${row.objects} objekter), markert${zoom ? " og zoomet" : ""}. ` +
      `StreamBIM fant ${found ?? "?"}/${row.objects} objekter.`
    );
  } catch (err) {
    log("Feil ved markering: " + errText(err));
    showNote(`Kunne ikke markere postnr ${row.postnr}: ${errText(err)}`);
  }
}

/** Liste → modell: marker alle stenger med samme postnr, og zoom dit. */
function selectAndZoom(row) {
  selectedKey = row.postnr;
  renderTable();
  return showGroup(row, { zoom: true, how: "Valgt" });
}

/** Klikk på valgt rad igjen: tomt fargekart = resetIfcSearch, som fjerner søket og nedtoningen. */
async function clearSelection() {
  selectedKey = null;
  renderTable();
  try {
    const result = await updateView(() => StreamBIM.API.colorCodeObjects({}));
    if (result !== SKIPPED) log("Valg nullstilt.");
  } catch (err) {
    log("Feil ved nullstilling: " + errText(err));
  }
}

function saveRestMode() {
  try {
    localStorage.setItem(REST_STORAGE_KEY, restModeSelect.value);
  } catch {
    // bare en bekvemmelighet — kan være sperret i iframe
  }
}

function loadRestMode() {
  try {
    const saved = localStorage.getItem(REST_STORAGE_KEY);
    if (REST_MODES.includes(saved)) restModeSelect.value = saved;
  } catch {
    // standard (tones ned) brukes
  }
}

/** Modell → liste: et klikk i 3D-vieweren (StreamBIM sitt pickedObject) markerer alle stenger
 *  med samme postnr, toner ned resten og flytter raden øverst — uten å flytte kameraet,
 *  siden brukeren allerede ser der. pickedObject kommer kun fra brukerklikk,
 *  ikke fra våre egne kall, så det trengs ingen vakt mot tilbakekobling. */
async function handlePickedObject(result) {
  const guid = result && result.guid;
  if (!guid) return;
  lastPickedGuid = guid;
  if (debugPanel.classList.contains("show")) updateDebugPanel(guid);

  const moved = moveToTop(rows, (row) => row.guids.includes(guid));
  if (!moved) {
    log(`Klikket element (${guid}) er ikke i lista${hasLoaded ? "" : " ennå"}.`);
    return;
  }

  rows = moved.rows;
  selectedKey = moved.row.postnr;
  // Skjuler søkefeltet raden, tømmes det, så den klikkede raden synes øverst.
  if (!filterRows([moved.row], filterInput.value).length) filterInput.value = "";
  renderTable();
  tableContainer.scrollTop = 0;
  await showGroup(moved.row, { zoom: false, how: "3D-klikk på" });
}

/** Viser hvilket egenskapsnavn hver kolonne traff på, pluss hele getObjectInfo()-svaret —
 *  slik at ekte egenskapsnavn kan leses av uten nettleserkonsoll. */
async function updateDebugPanel(guid) {
  try {
    const info = await StreamBIM.API.getObjectInfo(guid);
    const properties = objectProperties(info);
    const feltkobling = Object.fromEntries(
      Object.entries(FIELDS).map(([field, names]) => {
        const hit = findProperty(properties, names);
        return [field, hit ? `${hit.key} = ${hit.value}` : "IKKE FUNNET"];
      })
    );
    debugOutput.value = JSON.stringify({ guid, feltkobling, getObjectInfo: info }, null, 2);
  } catch (err) {
    debugOutput.value = `getObjectInfo(${guid}) feilet: ${errText(err)}`;
  }
}

/** Kopierer rådata + logg. navigator.clipboard er ofte sperret i en iframe på et annet
 *  domene, så execCommand("copy") er reserve. */
async function copyDebug() {
  const text = `${debugOutput.value}\n\n--- Logg ---\n${logEl.value}`;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "Kopiert ✔";
    return;
  } catch {
    // faller tilbake under
  }
  const scratch = document.createElement("textarea");
  scratch.value = text;
  document.body.appendChild(scratch);
  scratch.select();
  const copied = document.execCommand("copy");
  scratch.remove();
  copyBtn.textContent = copied ? "Kopiert ✔" : "Kunne ikke kopiere — merk teksten og trykk Ctrl+C";
}

debugToggle.addEventListener("click", () => {
  debugPanel.classList.toggle("show");
  if (debugPanel.classList.contains("show") && lastPickedGuid) updateDebugPanel(lastPickedGuid);
});
restModeSelect.addEventListener("change", () => {
  saveRestMode();
  // Gjelder med en gang: marker valgt gruppe på nytt med ny visning (kameraet blir stående).
  const row = rows.find((r) => r.postnr === selectedKey);
  if (row) showGroup(row, { zoom: false, how: "Ny visning for" });
});
filterInput.addEventListener("input", () => {
  renderTable();
  tableContainer.scrollTop = 0;
});
filterInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    // Enter velger første treff, så «Fd1500» + Enter markerer og zoomer.
    const first = filterRows(rows, filterInput.value)[0];
    if (first && first.postnr !== selectedKey) selectAndZoom(first);
  } else if (event.key === "Escape" && filterInput.value) {
    event.preventDefault();
    filterInput.value = "";
    renderTable();
  }
});
copyBtn.addEventListener("click", () => {
  copyDebug();
  setTimeout(() => (copyBtn.textContent = "Kopier rådata og logg"), 3000);
});

headerCells.forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    sortDir = sortKey === key ? -sortDir : 1;
    sortKey = key;
    rows = sortRows(rows, sortKey, sortDir);
    renderTable();
  });
});

refreshBtn.addEventListener("click", fetchRebarList);

/** connectToParent() godtar kun meldinger fra document.referrer sin origin. Åpnes siden
 *  direkte (ikke som iframe i StreamBIM), eller sender verten ingen referrer, blir det
 *  aldri noen tilkobling — vakthunden gir da en forklaring i stedet for evig "kobler til". */
async function main() {
  loadRestMode();
  renderTable();
  document.getElementById("version").textContent = `versjon ${WIDGET_VERSION}`;
  log(`Søk Armering versjon ${WIDGET_VERSION}`);
  log(`Referrer: ${document.referrer || "(ingen)"}`);

  if (window.parent === window) {
    setStatus("Åpnet utenfor StreamBIM ✘", "error");
    showNote("Denne siden er en StreamBIM-widget og må åpnes som widget inni et StreamBIM-prosjekt.");
    return;
  }

  const watchdog = setTimeout(() => {
    setStatus("Ingen kontakt med StreamBIM ✘", "error");
    showNote(
      "Fikk ikke svar fra StreamBIM innen 15 sekunder." +
      (document.referrer ? "" : " Siden fikk ingen referrer, og da avviser API-et alle meldinger fra verten.")
    );
  }, CONNECT_TIMEOUT_MS);

  try {
    await StreamBIM.connectToParent(window.parent, { pickedObject: handlePickedObject });
    clearTimeout(watchdog);
    showNote("");
    log("StreamBIM.connectToParent() lyktes.");
    StreamBIM.API.setShowExpandButton(true).catch((err) => log("setShowExpandButton feilet: " + errText(err)));
    await fetchRebarList();
  } catch (err) {
    clearTimeout(watchdog);
    setStatus("Kunne ikke koble til StreamBIM ✘", "error");
    log("Feil: " + errText(err));
  }
}

main();
