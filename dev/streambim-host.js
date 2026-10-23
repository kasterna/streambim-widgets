/* Testside mot EKTE StreamBIM: åpner prosjektet i embedded-modus (i en ramme eller i
 * eget vindu) og legger widgeten ved siden av. Siden står i midten og videresender:
 *   widget → API-kall → StreamBIM, og StreamBIM → pickedObject → widget.
 * Widgeten kjører uendret (connectToParent), akkurat som inni StreamBIM. Alle kall og
 * svar logges, og "Utforsk"-knappene henter etasjer/lag/kamera for å kartlegge hva
 * API-et faktisk leverer. UVERIFISERT: om StreamBIM godtar tilkobling fra localhost. */
(function () {
  const API_METHODS = [
    "getProjectId", "getUserEmail", "getBuildingId",
    "getCameraState", "setCameraState", "setCameraPosition", "getViewportState", "setViewportState", "applyViewpoint",
    "gotoObject", "gotoSpace", "gotoFloor", "goHome",
    "highlightObject", "deHighlightObject", "deHighlightAllObjects",
    "hideObject", "showObject", "showAllObjects", "highlightSystem",
    "getObjectInfo", "getFloors", "getSpaces", "valuesForObjectProperty",
    "findObjects", "applyObjectSearch", "getObjectInfoForSearch", "resetObjectSearch",
    "setSearchVisualizationMode", "zoomToSearchResult", "quickSearch",
    "colorCodeObjects", "colorCodeObjectsWithLegends", "colorCodeSpaces", "colorCodeSpacesWithLegends", "colorCodeByProperty",
    "getLayers", "setLayers", "showGrids", "hideGrids",
    "takeScreenshot", "getMapImage", "getAnnotatedFloorplan", "createObject",
    "setExpanded", "setShowExpandButton", "makeApiRequest",
    "setStyles", "setSkyColor", "setNavigationMode", "toggleShowAllFloors",
  ];
  const WIDGETS = {
    local: "../sok-armering/index.html",
    published: "https://kasterna.github.io/streambim-widgets/sok-armering/index.html",
  };
  const NO_CONTACT_HINT_MS = 20000;
  const MAX_LOG_LINES = 500;
  const STORAGE_KEY = "streambim-host-url";

  const urlInput = document.getElementById("url-input");
  const modeSelect = document.getElementById("mode-select");
  const widgetSelect = document.getElementById("widget-select");
  const connectBtn = document.getElementById("connect-btn");
  const statusEl = document.getElementById("status");
  const widgetFrame = document.getElementById("widget-frame");
  const viewerFrame = document.getElementById("viewer-frame");
  const viewerNote = document.getElementById("viewer-note");
  const logEl = document.getElementById("log");
  const exploreOutput = document.getElementById("explore-output");
  const cameraOutput = document.getElementById("camera-output");

  let streambim = null; // proxy til ekte StreamBIM
  let widget = null; // proxy til widgeten

  function errText(err) {
    if (!err) return "ukjent feil";
    if (err.code) return err.detail ? `${err.code} (${JSON.stringify(err.detail)})` : err.code;
    return err.message || JSON.stringify(err);
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || "";
  }

  function log(text, cls) {
    const li = document.createElement("li");
    li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    if (cls) li.className = cls;
    logEl.prepend(li);
    while (logEl.children.length > MAX_LOG_LINES) logEl.lastChild.remove();
  }

  function short(value, max = 160) {
    const text = JSON.stringify(value);
    if (text === undefined) return "undefined";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function summarize(result) {
    if (Array.isArray(result)) return `[${result.length} elementer] ${short(result.slice(0, 3))}`;
    return short(result);
  }

  /** Én videresender per API-metode — penpal trenger navngitte funksjoner, ikke en Proxy. */
  const relay = Object.fromEntries(
    API_METHODS.map((name) => [
      name,
      async (...args) => {
        const call = `${name}(${args.map((a) => short(a, 80)).join(", ")})`;
        try {
          const result = await streambim[name](...args);
          log(`${call} → ${summarize(result)}`);
          return result;
        } catch (err) {
          log(`${call} ✘ ${errText(err)}`, "error");
          throw err;
        }
      },
    ])
  );

  /** Hendelser fra StreamBIM. pickedObject sendes videre til widgeten; resten logges
   *  fordi de forteller hva et synlighetsfilter kan bygges på. */
  const events = {
    pickedObject(result) {
      log(`StreamBIM: pickedObject ${short(result)}`, "event");
      if (widget) widget.pickedObject(result).catch((err) => log(`Widgeten avviste pickedObject: ${errText(err)}`, "error"));
    },
    floorChanged(floorId) {
      log(`StreamBIM: floorChanged ${short(floorId)}`, "event");
    },
    spacesChanged(guids) {
      log(`StreamBIM: spacesChanged ${short(guids)}`, "event");
    },
    cameraChanged(state) {
      cameraOutput.textContent = JSON.stringify(state, null, 2);
    },
    didExpand() {},
    didContract() {},
    beforeInit() {
      log("StreamBIM: beforeInit", "event");
      return true;
    },
  };

  function openViewer(url) {
    if (modeSelect.value === "window") {
      const win = window.open(url, "streambim-test", "width=1400,height=900");
      if (!win) throw new Error("Nettleseren blokkerte vinduet. Tillat popup-vinduer for localhost og prøv igjen.");
      viewerFrame.hidden = true;
      viewerNote.hidden = false;
      return StreamBIM.connectToWindow(win, url, events);
    }
    viewerFrame.hidden = false;
    viewerNote.hidden = true;
    viewerFrame.src = url;
    return StreamBIM.connectToChild(viewerFrame, events);
  }

  /** `?viewer=fake-viewer.html` bytter ut ekte StreamBIM med en lokal etterligning, så
   *  videresendingen kan testes uten innlogging. */
  function viewerUrl() {
    const override = new URLSearchParams(location.search).get("viewer");
    return override ? new URL(override, location.href).href : StreamBimUrl.buildEmbeddedUrl(urlInput.value);
  }

  async function connect() {
    let url;
    try {
      url = viewerUrl();
    } catch (err) {
      setStatus(err.message, "error");
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, urlInput.value.trim());
    } catch {
      // bare en bekvemmelighet
    }

    connectBtn.disabled = true;
    setStatus("Venter på StreamBIM… Logg inn i StreamBIM hvis du blir bedt om det.", "busy");
    log(`Åpner ${url}`);
    const hint = setTimeout(() => {
      setStatus(
        "Ingen kontakt med StreamBIM ennå. Er du logget inn og ser modellen? Prøv ellers «Eget vindu», " +
        "ellers godtar StreamBIM trolig ikke tilkobling fra en lokal side.",
        "error"
      );
    }, NO_CONTACT_HINT_MS);

    try {
      await openViewer(url);
      streambim = StreamBIM.API;
      clearTimeout(hint);
      log("Tilkoblet ekte StreamBIM ✔", "ok");
      const user = await checkLogin();

      widgetFrame.src = WIDGETS[widgetSelect.value];
      await StreamBIM.connectToChild(widgetFrame, relay);
      widget = StreamBIM.API;
      if (user) setStatus(`StreamBIM og widget tilkoblet ✔ (innlogget som ${user})`, "ok");
      log("Widget tilkoblet ✔", "ok");
      // Uten innlogging: logg inn i StreamBIM og koble til på nytt (samme vindu gjenbrukes).
      connectBtn.disabled = Boolean(user);
      document.querySelectorAll("[data-explore]").forEach((btn) => (btn.disabled = false));
    } catch (err) {
      clearTimeout(hint);
      setStatus(`Tilkobling feilet: ${errText(err)}`, "error");
      log(`Tilkobling feilet: ${errText(err)}`, "error");
      connectBtn.disabled = false;
    }
  }

  /** Uten innlogging svarer StreamBIM med {code:"unknown"} på alt som trenger data (sett
   *  i ramme-modus, der nettleseren ikke deler innloggingen). Sjekkes før widgeten
   *  starter, så feilen ikke ser ut som "ingen armering". */
  async function checkLogin() {
    try {
      const user = await streambim.getUserEmail();
      log(`Innlogget i StreamBIM som ${user}`, "ok");
      return user;
    } catch (err) {
      log(`getUserEmail ✘ ${errText(err)}: StreamBIM er ikke innlogget`, "error");
      setStatus(
        modeSelect.value === "frame"
          ? "StreamBIM er ikke innlogget i rammen. Velg «Eget vindu» og trykk «Koble til» igjen."
          : "StreamBIM er ikke innlogget. Logg inn i StreamBIM-vinduet og trykk «Koble til» igjen.",
        "error"
      );
      return null;
    }
  }

  async function explore(method) {
    exploreOutput.textContent = `${method}()…`;
    try {
      const result = await streambim[method]();
      exploreOutput.textContent = `${method}():\n${JSON.stringify(result, null, 2)}`;
    } catch (err) {
      exploreOutput.textContent = `${method}() ✘ ${errText(err)}`;
    }
  }

  document.querySelectorAll("[data-explore]").forEach((btn) => {
    btn.addEventListener("click", () => explore(btn.dataset.explore));
  });
  connectBtn.addEventListener("click", connect);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !connectBtn.disabled) connect();
  });

  try {
    urlInput.value = new URLSearchParams(location.search).get("url") || localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    // localStorage kan være sperret
  }

  window.streambimHost = { get streambim() { return streambim; }, get widget() { return widget; } };
})();
