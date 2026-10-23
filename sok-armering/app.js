const {
  FIELDS,
  REBAR_SEARCHES,
  findProperty,
  objectProperties,
  isRebarObject,
  groupRebar,
  groupSearchQueries,
  isUsableGroupSearch,
  sortRows,
  formatLengde,
  moveToTop,
  mapWithConcurrency,
} = window.RebarLib;

// Versjonen står bare ett sted: ?v= på skript-taggene i index.html.
const WIDGET_VERSION = new URL(document.currentScript.src).searchParams.get("v") || "ukjent";

const SEARCH_LIMIT = 10000;
const INFO_CONCURRENCY = 10;
const HIGHLIGHT_CONCURRENCY = 20;
const CONNECT_TIMEOUT_MS = 15000;
const COLUMNS = ["postnr", "count", "diameter", "lengde", "formkode", "segment"];

const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh-btn");
const countEl = document.getElementById("count");
const noteEl = document.getElementById("note");
const tableContainer = document.getElementById("table-container");
const tableBody = document.querySelector("#rebar-table tbody");
const headerCells = document.querySelectorAll("#rebar-table th[data-key]");
const debugToggle = document.getElementById("debug-toggle");
const debugPanel = document.getElementById("debug-panel");
const debugOutput = document.getElementById("debug-output");
const logEl = document.getElementById("log");
const searchTestBtn = document.getElementById("search-test-btn");
const copyBtn = document.getElementById("copy-btn");

let rows = []; // grouped rebar rows currently shown
let sortKey = "postnr";
let sortDir = 1;
let selectedKey = null; // postnr of the highlighted row
let lastPickedGuid = null;
let hasLoaded = false;
let rebarObjectCount = 0; // armeringsobjekter i lista — brukes til å avsløre søk som ikke filtrerer

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

/** Kjører alle søkene i REBAR_SEARCHES og slår sammen GUID-ene. Treff per søkeverdi
 *  logges, så det synes om StreamBIM faktisk filtrerer (i første live-test ga alle
 *  verdier de samme objektene). */
async function findAllRebarGuids() {
  const guids = new Set();
  for (const search of REBAR_SEARCHES) {
    const counts = [];
    for (const value of search.values) {
      try {
        const found = (await StreamBIM.API.findObjects({ key: search.key, value, limit: SEARCH_LIMIT })) || [];
        found.forEach((guid) => guids.add(guid));
        counts.push(`"${value}"=${found.length}`);
      } catch (err) {
        counts.push(`"${value}"=feil (${errText(err)})`);
      }
    }
    log(`Søk på ${search.label}: ${counts.join(", ")}.`);
  }
  log(`Til sammen ${guids.size} unike objekter fra søkene.`);
  return Array.from(guids);
}

/** Henter info per objekt og beholder bare armering (@kind), siden søkene ikke filtrerer
 *  pålitelig. Egenskapene samles fra både `properties` og `groups` (objectProperties). */
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

async function fetchRebarList() {
  refreshBtn.disabled = true;
  setStatus("Søker etter armering...", "busy");
  showNote("");

  try {
    const guids = await findAllRebarGuids();
    if (guids.length === 0) {
      rows = [];
      hasLoaded = true;
      renderTable();
      countEl.textContent = "0 armeringselementer funnet.";
      showNote(
        "Fant ingen armering via @kind (Reinforcing bar/mesh) eller Common Type. " +
        "Klikk et armeringselement i 3D-vieweren og åpne \"Feilsøking\" nederst for å se hvilke " +
        "egenskaper StreamBIM faktisk har på elementet."
      );
      setStatus("Tilkoblet StreamBIM ✔ (0 treff)", "ok");
      return;
    }

    const items = await fetchRebarInfo(guids);
    const { rows: grouped, missingPostnr } = groupRebar(items);
    rows = sortRows(grouped, sortKey, sortDir);
    rebarObjectCount = items.length;
    selectedKey = null;
    hasLoaded = true;
    renderTable();

    const bars = rows.reduce((sum, row) => sum + row.count, 0);
    countEl.textContent = `${bars} stenger i ${items.length} IFC-objekter (${rows.length} unike postnr).`;
    if (missingPostnr > 0) {
      showNote(
        `${missingPostnr} elementer manglet postnr-egenskapen. Klikk ett av dem i 3D-vieweren og ` +
        "åpne \"Feilsøking\" for å se hva postnr heter i denne modellen."
      );
    }
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

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.id = "empty-row";
    const td = document.createElement("td");
    td.colSpan = COLUMNS.length;
    td.textContent = hasLoaded ? "Ingen armering i lista." : "Lista lastes når widgeten er koblet til StreamBIM.";
    tr.appendChild(td);
    tableBody.appendChild(tr);
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.postnr === selectedKey) tr.className = "selected";
    const values = [row.postnr, row.count, row.diameter, formatLengde(row.lengde), row.formkode, row.segment];
    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value ?? "";
      tr.appendChild(td);
    }
    tr.addEventListener("click", () => selectAndZoom(row));
    tableBody.appendChild(tr);
  }

  headerCells.forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === sortKey);
    th.classList.toggle("desc", th.dataset.key === sortKey && sortDir === -1);
  });
}

/** StreamBIM har bare enkelt-GUID highlightObject() og ingen samlet "velg disse", så
 *  hele gruppen highlightes én og én med begrenset samtidighet. */
async function highlightGroup(row) {
  await StreamBIM.API.deHighlightAllObjects();
  await mapWithConcurrency(row.guids, HIGHLIGHT_CONCURRENCY, (guid) => StreamBIM.API.highlightObject(guid));
}

/** Rammer inn HELE postnr-gruppen: prøver søkene fra groupSearchQueries() med
 *  applyObjectSearch() + zoomToSearchResult() (visningsmodus ORIGINAL, så resten av
 *  modellen ikke tones ned). Et søk brukes bare hvis det faktisk filtrerte
 *  (isUsableGroupSearch) — ellers ville zoomen rammet inn hele modellen. Duger ingen,
 *  nullstilles søket og kameraet går til første objekt med gotoObject(). */
async function zoomToGroup(row) {
  for (const { label, query } of groupSearchQueries(row, SEARCH_LIMIT)) {
    try {
      const hits = await StreamBIM.API.applyObjectSearch(query, true);
      if (isUsableGroupSearch(hits, row, rebarObjectCount)) {
        await StreamBIM.API.setSearchVisualizationMode("ORIGINAL");
        await StreamBIM.API.zoomToSearchResult();
        return `hele gruppen (${label}: ${hits.length} treff)`;
      }
      log(`Søk (${label}) ga ${hits ? hits.length : 0} treff for ${row.objects} objekter — ikke brukbart.`);
    } catch (err) {
      log(`Søk (${label}) feilet: ${errText(err)}.`);
    }
  }
  await StreamBIM.API.resetObjectSearch().catch(() => {});
  await StreamBIM.API.gotoObject(row.guids[0]);
  return "første objekt";
}

/** Liste → modell: highlight og zoom til alle stenger med samme postnr. */
async function selectAndZoom(row) {
  selectedKey = row.postnr;
  renderTable();
  try {
    await highlightGroup(row);
    const target = await zoomToGroup(row);
    log(`Valgt postnr ${row.postnr} (${row.count} stk), zoomet til ${target}.`);
  } catch (err) {
    log("Feil ved valg/zoom: " + errText(err));
  }
}

/** Modell → liste: et klikk i 3D-vieweren (StreamBIM sitt pickedObject) utvider valget
 *  til alle stenger med samme postnr og flytter raden øverst. pickedObject kommer kun
 *  fra brukerklikk, ikke fra våre egne highlightObject()-kall, så det trengs ingen
 *  vakt mot tilbakekobling. */
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
  renderTable();
  tableContainer.scrollTop = 0;
  log(`Postnr ${moved.row.postnr} klikket i 3D-viewer (${moved.row.count} stk, utvider valg).`);

  try {
    await highlightGroup(moved.row);
  } catch (err) {
    log("Feil ved utvidelse av valg: " + errText(err));
  }
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

async function countResult(call) {
  try {
    const result = await call();
    return Array.isArray(result) ? result.length : result;
  } catch (err) {
    return `feil: ${errText(err)}`;
  }
}

/** Kartlegger hvordan StreamBIM sine søk faktisk filtrerer, med raden som er valgt (eller
 *  første rad med postnr): et søk som filtrerer gir omtrent gruppens antall objekter, et
 *  som ignorerer filteret gir alle. applyObjectSearch nullstilles etterpå. */
async function runSearchTest() {
  const row = rows.find((r) => r.postnr === selectedKey && r.searchKey) || rows.find((r) => r.searchKey);
  if (!row) {
    debugOutput.value = "Ingen rad med postnr å teste med. Trykk «Oppdater liste» først.";
    return;
  }
  debugOutput.value = `Tester søk med postnr ${row.postnr}…`;
  const find = (query) => countResult(() => StreamBIM.API.findObjects(query));
  const queries = groupSearchQueries(row, SEARCH_LIMIT);
  const result = {
    postnr: row.postnr,
    forventetObjekter: row.objects,
    armeringsobjekterILista: rebarObjectCount,
    findObjects: {
      kindReinforcingBar: await find({ key: "@kind", value: "Reinforcing bar", limit: SEARCH_LIMIT }),
      kindFinnesIkke: await find({ key: "@kind", value: "Finnes-ikke-xyz", limit: SEARCH_LIMIT }),
      postnr: await find({ key: row.searchKey, value: row.postnr, limit: SEARCH_LIMIT }),
      psetPostnr: await find({ key: `${row.searchPset}~${row.searchKey}`, value: row.postnr, limit: SEARCH_LIMIT }),
    },
    getObjectInfoForSearch: {},
    applyObjectSearch: {},
    valuesForObjectProperty: await countResult(() =>
      StreamBIM.API.valuesForObjectProperty(`${row.searchPset}~${row.searchKey}`)
    ),
  };
  for (const { label, query } of queries) {
    result.getObjectInfoForSearch[label] = await countResult(() => StreamBIM.API.getObjectInfoForSearch(query));
    result.applyObjectSearch[label] = await countResult(() => StreamBIM.API.applyObjectSearch(query, true));
  }
  await StreamBIM.API.resetObjectSearch().catch(() => {});
  debugOutput.value = JSON.stringify({ søketest: result, søk: queries }, null, 2);
  log(`Søketest ferdig for postnr ${row.postnr}.`);
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
searchTestBtn.addEventListener("click", runSearchTest);
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
