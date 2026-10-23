/* Lokal etterligning av StreamBIM-verten: legger widgeten i en iframe og svarer på de
 * samme API-kallene via StreamBIM.connectToChild() (samme penpal-transport som ekte
 * StreamBIM bruker). Høyre side er enten en ekte armeringsmodell i 3D (laget med
 * tools/ifc-til-testmodell.py, ligger i dev/models/) eller oppdiktede testobjekter som
 * knapper. Klikk på en stang/knapp = pickedObject til widgeten.
 *
 * Innstillinger via URL: ?model=<fil i models/>|testdata, ?widget=../sok-armering/index.html
 * pluss format/kind/search (se mock-api.js). */
(async function () {
  const params = new URLSearchParams(location.search);
  const settings = {
    ...MockApi.readSettings(params),
    widget: params.get("widget") || "../sok-armering/index.html",
    model: params.get("model"),
  };

  const viewEl = document.getElementById("view");
  const cameraEl = document.getElementById("camera");
  const callsEl = document.getElementById("calls");
  const frame = document.getElementById("widget-frame");
  const modelSelect = document.getElementById("model-select");

  function logCall(name, args) {
    const li = document.createElement("li");
    li.textContent = `${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    callsEl.prepend(li);
    while (callsEl.children.length > 200) callsEl.lastChild.remove();
  }

  /** models/index.json lages av ifc-til-testmodell.py. Mangler den, finnes bare testdata. */
  async function loadModelIndex() {
    try {
      const response = await fetch("models/index.json", { cache: "no-store" });
      return response.ok ? await response.json() : [];
    } catch {
      return [];
    }
  }

  const index = await loadModelIndex();
  for (const entry of index) modelSelect.add(new Option(`${entry.label} (3D)`, entry.file));
  // Uten ?model= velges første ekte modell hvis det finnes en.
  settings.model ??= index.length ? index[0].file : "testdata";
  if (![...modelSelect.options].some((o) => o.value === settings.model)) settings.model = "testdata";

  let model = null;
  if (settings.model !== "testdata") {
    cameraEl.textContent = `Laster ${settings.model}…`;
    model = await (await fetch(`models/${encodeURIComponent(settings.model)}`)).json();
  }

  // Kall som bare leser data endrer ikke visningen, så 3D-visningen trenger ikke
  // oppdateres for hvert av de mange getObjectInfo()-kallene.
  const READ_ONLY_CALLS = new Set([
    "getProjectId", "getUserEmail", "getFloors", "getLayers", "getCameraState",
    "findObjects", "getObjectInfo", "setShowExpandButton",
  ]);

  let view = null; // 3D-visning når en ekte modell er lastet
  const mock = MockApi.createMockApi(
    settings,
    (name, args) => {
      logCall(name, args);
      if (!READ_ONLY_CALLS.has(name)) render();
    },
    model ? model.objects : undefined
  );

  function pick(obj, point) {
    MockApi.pickObject(mock, obj, StreamBIM.API, point);
    render();
  }

  function render() {
    if (view) {
      cameraEl.textContent = MockApi.cameraText(mock.state);
      view.update(mock.state);
    } else {
      MockApi.renderMockView(mock, viewEl, cameraEl, (obj) => pick(obj));
    }
  }

  if (model) {
    viewEl.classList.add("three");
    const { createModelView } = await import("./model-view.js");
    view = createModelView(viewEl, model, pick);
  }

  document.querySelectorAll("[data-setting]").forEach((input) => {
    const key = input.dataset.setting;
    if (input.type === "checkbox") input.checked = settings[key];
    else input.value = settings[key];
    input.addEventListener("change", () => {
      const next = new URLSearchParams(location.search);
      next.set(key, input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value);
      location.search = next.toString();
    });
  });

  render();
  frame.src = settings.widget;
  StreamBIM.connectToChild(frame, mock.methods)
    .then(() => {
      document.getElementById("host-status").textContent = "Widget tilkoblet ✔";
      window.mockHost = {
        api: StreamBIM.API,
        objects: mock.objects,
        state: mock.state,
        highlighted: mock.state.highlighted,
        view,
        pick,
        get camera() {
          return mock.state.camera;
        },
      };
    })
    .catch((err) => {
      document.getElementById("host-status").textContent = "Tilkobling feilet: " + JSON.stringify(err);
    });
})();
