/* Falsk StreamBIM-API, delt av mock-host.html (StreamBIM som forelder til widgeten) og
 * fake-viewer.html (StreamBIM som barn i embedded-modus, for å teste
 * streambim-host.html). Svarer på de samme kallene som ekte StreamBIM.
 *
 * Objektene har formen {guid, name, kind, center, psets: {Pset: {Egenskap: verdi}}} —
 * enten de oppdiktede i mock-model.js eller en ekte modell fra tools/ifc-til-testmodell.py.
 *
 * Innstillinger (URL-parametre):
 *   format=streambim  (standard) som ekte StreamBIM: IFC-attributter i `properties`,
 *                     Pset-ene i `groups[]` med {key, value} som tekst
 *   format=flat|tilde|nested  eldre gjetninger om formen, for å teste findProperty
 *   findfilter=1      findObjects filtrerer på nøkkel/verdi. Standard er AV, fordi ekte
 *                     StreamBIM ga de samme objektene for hver søkeverdi i live-test.
 *   kind=0            @kind-søk gir ingen treff
 *   search=0          applyObjectSearch/zoomToSearchResult støttes ikke
 *   uten3d=31,27      disse postnummerne får 0 flater i "Geometry" (som etter en mangelfull
 *                     import: objektet finnes i data, men vises ikke i 3D) */
(function () {
  function readSettings(params) {
    return {
      format: params.get("format") || "streambim",
      findfilter: params.get("findfilter") === "1",
      kind: params.get("kind") !== "0",
      search: params.get("search") !== "0",
      uten3d: (params.get("uten3d") || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  function postnrOf(obj) {
    for (const props of Object.values(obj.psets)) {
      const value = props.Posisjonsnummer ?? props["ARM.07 - Posnr"];
      if (value !== undefined) return String(value);
    }
    return null;
  }

  /** "ReinforcingBar" → "Reinforcing bar", slik ekte StreamBIM viser @kind. */
  function readableKind(kind) {
    const words = kind.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
    return [words[0], ...words.slice(1).map((w) => w.toLowerCase())].join(" ");
  }

  function createMockApi(settings, onCall, objects = window.MockModel.objects) {
    const byGuid = new Map(objects.map((o) => [o.guid, o]));
    const state = {
      highlighted: new Set(),
      activeSearch: null, // Set med GUID-er
      camera: "Hjem",
      focus: [], // GUID-er kameraet sist ble bedt om å ramme inn (3D-visningen zoomer dit)
      focusVersion: 0,
      visualizationMode: "FADED",
      colorCoded: new Map(), // guid -> farge fra colorCodeObjects
      buildingId: "1000", // aktiv bygning
    };

    function setFocus(guids, text) {
      state.focus = guids;
      state.focusVersion++;
      state.camera = text;
    }

    /** [minX, minY, minZ, maxX, maxY, maxZ] som ekte StreamBIM, fra 3D-geometrien når den
     *  finnes, ellers en liten boks rundt midtpunktet (oppdiktet testdata). */
    const bboxCache = new Map();
    function bboxOf(obj) {
      if (!bboxCache.has(obj.guid)) {
        let box;
        if (obj.mesh && obj.mesh.v.length) {
          const v = obj.mesh.v;
          box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          for (let i = 0; i < v.length; i += 3) {
            for (let axis = 0; axis < 3; axis++) {
              box[axis] = Math.min(box[axis], v[i + axis]);
              box[axis + 3] = Math.max(box[axis + 3], v[i + axis]);
            }
          }
        } else {
          box = [...obj.center.map((c) => c - 0.1), ...obj.center.map((c) => c + 0.1)];
        }
        bboxCache.set(obj.guid, box);
      }
      return bboxCache.get(obj.guid);
    }

    /** "Geometry"-gruppen slik ekte StreamBIM har den; 0 flater for postnr i uten3d. */
    function geometryGroupFor(obj) {
      const missing = settings.uten3d.includes(postnrOf(obj));
      return { "Faces Hi": missing ? "0" : "80", "Faces Lo": missing ? "0" : "20" };
    }

    /** getObjectInfo()-svaret i valgt form. "streambim" er formen ekte StreamBIM bruker. */
    function objectInfoFor(obj) {
      if (settings.format === "streambim") {
        return {
          layer: "MockARM",
          properties: { "@kind": readableKind(obj.kind), Name: obj.name, "Global Id": obj.guid, BaseType: "ifcelement" },
          groups: Object.entries({ ...obj.psets, Geometry: geometryGroupFor(obj) }).map(([label, props]) => ({
            label,
            source: "GRAPH",
            content: {
              properties: Object.entries(props).map(([key, value]) => ({
                key,
                value: String(value),
                valueType: typeof value === "number" ? "float8" : "str",
              })),
              children: null,
            },
          })),
          center: obj.center,
          bbox: bboxOf(obj),
          floors: ["1001"],
          building: "1000",
        };
      }
      const entries = Object.entries(obj.psets).flatMap(([pset, props]) =>
        Object.entries(props).map(([key, value]) => ({ pset, key, value }))
      );
      let properties;
      if (settings.format === "tilde") properties = Object.fromEntries(entries.map((e) => [`${e.pset}~${e.key}`, e.value]));
      else if (settings.format === "nested") properties = obj.psets;
      else properties = Object.fromEntries(entries.map((e) => [e.key, [e.value]])); // flat
      return { guid: obj.guid, name: obj.name, center: obj.center, properties };
    }

    /** Ett søkekriterium: @kind (lesbar eller IFC-form), "Pset~Egenskap" eller bare
     *  egenskapsnavnet, eventuelt avgrenset til ett Pset. */
    function matches(obj, key, value, pset, operator) {
      // StreamBIM sin egen "disse objektene"-regel (searchForObjects): @guid in a|b|c
      if (key === "@guid") return operator === "in" ? String(value).split("|").includes(obj.guid) : obj.guid === value;
      if (key === "@kind") {
        const wanted = String(value).toLowerCase();
        return settings.kind && (obj.kind.toLowerCase() === wanted || readableKind(obj.kind).toLowerCase() === wanted);
      }
      const [psetName, propKey] = key.includes("~") ? key.split("~") : [pset, key];
      return Object.entries(obj.psets).some(
        ([name, props]) =>
          (!psetName || name === psetName) &&
          Object.prototype.hasOwnProperty.call(props, propKey) &&
          String(props[propKey]) === String(value)
      );
    }

    /** Støtter {key, value, limit} og regel-formatet {rules: [[regel]]} — på toppnivå slik
     *  ekte StreamBIM leser det for findObjects/applyObjectSearch, eller under `filter` slik
     *  getObjectInfoForSearch leser det. Ytre liste = ELLER, indre = OG. */
    function search(query) {
      const limit = query.limit || (query.page && query.page.limit) || 100;
      const rules = query.rules || (query.filter && query.filter.rules);
      let predicate;
      if (Array.isArray(rules)) {
        predicate = (o) =>
          rules.some((group) => group.every((rule) => matches(o, rule.propKey, rule.propValue, rule.psetName, rule.operator)));
      } else {
        const { key, value } = query.filter || query;
        predicate = (o) => matches(o, key, value);
      }
      return objects.filter(predicate).slice(0, limit).map((o) => o.guid);
    }

    function unsupported(name) {
      return async () => {
        throw { code: "MOCK_NOT_SUPPORTED", detail: `${name} er slått av i mocken` };
      };
    }

    // Ingen kunstig forsinkelse: i en skjult fane strupes setTimeout til ~1 s, og da tok
    // 250 getObjectInfo()-kall mange sekunder.
    const api = {
      getProjectId: async () => "mock-project",
      getBuildingId: async () => state.buildingId, // kan endres i konsollen for å simulere bygningsbytte
      getUserEmail: async () => "mock@example.com",
      setShowExpandButton: async () => true,
      getFloors: async () => [{ id: 1, name: "Plan 1", height: 0 }, { id: 2, name: "Plan 2", height: 3.6 }],
      getLayers: async () => ({ RIB: true, ARK: false }),
      getCameraState: async () => ({ position: [10, 10, 10], quaternion: [1, 0, 0, 0] }),
      // Uten findfilter=1 gir findObjects alle objektene, slik ekte StreamBIM gjorde i live-test.
      findObjects: async (query) =>
        settings.findfilter ? search(query) : objects.slice(0, query.limit || 100).map((o) => o.guid),
      getObjectInfo: async (guid) => {
        const obj = byGuid.get(guid);
        if (!obj) throw { code: "unknown", debug: guid };
        return objectInfoFor(obj);
      },
      getObjectInfoForSearch: async (query) => search(query).map((guid) => objectInfoFor(byGuid.get(guid))),
      valuesForObjectProperty: async (psetAndKey) => {
        const [pset, key] = psetAndKey.split("~");
        const values = objects.map((o) => o.psets[pset] && o.psets[pset][key]).filter((v) => v !== undefined);
        return [...new Set(values.map(String))];
      },
      highlightObject: async (guid) => {
        state.highlighted.add(guid);
        return true;
      },
      deHighlightObject: async (guid) => state.highlighted.delete(guid),
      deHighlightAllObjects: async () => {
        state.highlighted.clear();
        return true;
      },
      gotoObject: async (guid) => {
        setFocus([guid], `Objekt ${byGuid.has(guid) ? byGuid.get(guid).name : guid}`);
        return true;
      },
      // Som i StreamBIM sin kode: et søk fjerner utvalget (highlightObject = "velg"), og
      // applyObjectSearch returnerer bare true — ikke treffene README lover.
      applyObjectSearch: settings.search
        ? async (query) => {
            state.highlighted.clear();
            state.activeSearch = new Set(search(query));
            return true;
          }
        : unsupported("applyObjectSearch"),
      // Som i StreamBIM sin kode: farger objektene og gjør dem til aktivt søk ("@guid in"),
      // så setSearchVisualizationMode og zoomToSearchResult virker på nettopp dem. Tomt
      // kart fjerner fargene og søket.
      colorCodeObjects: async (map) => {
        const entries = Object.entries(map || {});
        state.highlighted.clear();
        state.colorCoded = new Map(entries);
        state.activeSearch = entries.length ? new Set(entries.map(([guid]) => guid)) : null;
        // Tomt kart = resetIfcSearch, som også nullstiller visningsmodus til standard (FADED).
        if (!entries.length) state.visualizationMode = "FADED";
        return true;
      },
      setSearchVisualizationMode: settings.search
        ? async (mode) => {
            state.visualizationMode = mode;
            return true;
          }
        : unsupported("setSearchVisualizationMode"),
      zoomToSearchResult: settings.search
        ? async () => {
            if (!state.activeSearch) {
              state.camera = "Ingen aktivt søk";
              return true;
            }
            setFocus([...state.activeSearch], `Søkeresultat (${state.activeSearch.size} objekter)`);
            return true;
          }
        : unsupported("zoomToSearchResult"),
      resetObjectSearch: async () => {
        state.activeSearch = null;
        state.highlighted.clear();
        return true;
      },
    };

    /** Pakker hver metode slik at kallet meldes til `onCall` (logg + ny tegning). */
    const methods = Object.fromEntries(
      Object.entries(api).map(([name, fn]) => [
        name,
        async (...args) => {
          try {
            return await fn(...args);
          } finally {
            onCall(name, args);
          }
        },
      ])
    );

    return { objects, state, methods };
  }

  function cameraText(state) {
    const searchText = state.activeSearch ? `${state.activeSearch.size} treff (${state.visualizationMode})` : "ingen";
    return `Kamera: ${state.camera} · søk: ${searchText}`;
  }

  /** Tegner kamera-linja og én klikkbar rute per objekt (brukes uten 3D-modell). */
  function renderMockView(mock, viewEl, cameraEl, onPick) {
    const { state } = mock;
    cameraEl.textContent = cameraText(state);
    viewEl.replaceChildren(
      ...mock.objects.map((obj) => {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = `tile kind-${obj.kind}`;
        if (state.highlighted.has(obj.guid)) tile.classList.add("highlighted");
        if (state.colorCoded.has(obj.guid)) {
          tile.style.background = state.colorCoded.get(obj.guid);
          tile.style.color = "#222";
        }
        if (state.activeSearch && !state.activeSearch.has(obj.guid)) {
          if (state.visualizationMode === "FADED") tile.classList.add("faded");
          if (state.visualizationMode === "HIDDEN") tile.style.display = "none";
        }
        tile.textContent = obj.name;
        tile.title = obj.guid;
        tile.addEventListener("click", () => onPick(obj));
        return tile;
      })
    );
  }

  /** Simulerer et brukerklikk: highlight bare det objektet og send pickedObject. */
  function pickObject(mock, obj, remote, point = obj.center) {
    mock.state.highlighted.clear();
    mock.state.highlighted.add(obj.guid);
    if (remote) remote.pickedObject({ guid: obj.guid, point }).catch((err) => console.error(err));
  }

  window.MockApi = { readSettings, createMockApi, renderMockView, pickObject, cameraText };
})();
