/* 3D-visning av en testmodell (fra tools/ifc-til-testmodell.py) for mock-verten. Én mesh
 * per armeringsobjekt, og betongen som gjennomsiktig kontekst. Klikk på en stang kaller
 * onPick(obj, punkt). update(state) farger highlight og søk og zoomer når state.focus
 * endres — slik StreamBIM reagerer på widgetens kall. Brukes lokalt (three fra node_modules). */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const COLORS = {
  ReinforcingBar: 0xc0703a,
  ReinforcingMesh: 0x9a6ab0,
  highlight: 0xffd400,
  context: 0x9aa3ab,
  background: 0x1d2023,
};
const CLICK_TOLERANCE_PX = 4; // mer bevegelse enn dette mellom ned og opp = rotering, ikke klikk
const PICK_TOLERANCE_PX = 6; // stenger er 10–16 mm tykke: godta klikk så nær stangen
const FIT_MARGIN = 1.15;

function geometryFor(mesh) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.v, 3));
  geometry.setIndex(mesh.f);
  geometry.computeVertexNormals();
  return geometry;
}

export function createModelView(container, model, onPick) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(30, -20, 50);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.up.set(0, 0, 1); // IFC er Z-opp
  const controls = new OrbitControls(camera, renderer.domElement);

  const normalMaterials = {};
  const normalMaterial = (kind) =>
    (normalMaterials[kind] ??= new THREE.MeshLambertMaterial({ color: COLORS[kind] ?? COLORS.ReinforcingBar }));
  const highlightMaterial = new THREE.MeshLambertMaterial({ color: COLORS.highlight, emissive: 0x332200 });
  const colorMaterials = new Map(); // farge fra colorCodeObjects -> materiale
  const colorMaterial = (color) => {
    if (!colorMaterials.has(color)) colorMaterials.set(color, new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
    return colorMaterials.get(color);
  };
  const fadedMaterial = new THREE.MeshLambertMaterial({ color: 0x777777, transparent: true, opacity: 0.12, depthWrite: false });
  const contextMaterial = new THREE.MeshLambertMaterial({
    color: COLORS.context,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const meshes = new Map(); // guid -> THREE.Mesh
  for (const obj of model.objects) {
    const mesh = new THREE.Mesh(geometryFor(obj.mesh), normalMaterial(obj.kind));
    mesh.userData.obj = obj;
    meshes.set(obj.guid, mesh);
    scene.add(mesh);
  }
  const contextMeshes = (model.context || []).map((ctx) => {
    const mesh = new THREE.Mesh(geometryFor(ctx.mesh), contextMaterial);
    mesh.renderOrder = 1; // tegnes etter armeringen så stengene synes gjennom betongen
    scene.add(mesh);
    return mesh;
  });
  const pickables = [...meshes.values()];

  function fitTo(objects3d) {
    const box = new THREE.Box3();
    objects3d.forEach((o) => box.expandByObject(o));
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.2);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * FIT_MARGIN;
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-9) direction.set(1, -1.2, 0.9);
    direction.normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = distance / 200;
    camera.far = distance * 50;
    camera.updateProjectionMatrix();
    controls.update();
  }

  /** GPU-plukking: hver stang tegnes med sin egen farge (id + 1) i et lite område rundt
   *  pekeren, og pikselen nærmest midten vinner. Treffer tynne stenger på avstand og
   *  respekterer hva som ligger foran — en stråle (raycast) bommer på 10 mm-stenger. */
  const pickSize = Math.round((2 * PICK_TOLERANCE_PX + 1) * renderer.getPixelRatio());
  const pickTarget = new THREE.WebGLRenderTarget(pickSize, pickSize);
  const pickScene = new THREE.Scene();
  const pickMeshes = pickables.map((mesh, i) => {
    const id = i + 1;
    const material = new THREE.MeshBasicMaterial();
    material.color.setRGB((id >> 16) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255, THREE.LinearSRGBColorSpace);
    const pickMesh = new THREE.Mesh(mesh.geometry, material);
    pickScene.add(pickMesh);
    return pickMesh;
  });
  const pickPixels = new Uint8Array(pickSize * pickSize * 4);
  const raycaster = new THREE.Raycaster();

  function pickAtClient(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ratio = renderer.getPixelRatio();
    const half = Math.floor(pickSize / 2);
    pickMeshes.forEach((pickMesh, i) => (pickMesh.visible = pickables[i].visible));

    camera.setViewOffset(
      rect.width * ratio,
      rect.height * ratio,
      (clientX - rect.left) * ratio - half,
      (clientY - rect.top) * ratio - half,
      pickSize,
      pickSize
    );
    const clearColor = renderer.getClearColor(new THREE.Color());
    renderer.setRenderTarget(pickTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(pickScene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clearColor);
    camera.clearViewOffset();
    renderer.readRenderTargetPixels(pickTarget, 0, 0, pickSize, pickSize, pickPixels);

    let best = null;
    for (let i = 0; i < pickSize * pickSize; i++) {
      const id = (pickPixels[i * 4] << 16) | (pickPixels[i * 4 + 1] << 8) | pickPixels[i * 4 + 2];
      if (!id) continue;
      const dist = Math.hypot((i % pickSize) - half, Math.floor(i / pickSize) - half);
      if (!best || dist < best.dist) best = { dist, mesh: pickables[id - 1] };
    }
    if (!best) return null;

    // Klikkpunktet i 3D: der strålen treffer stangen, ellers stangens midtpunkt.
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(best.mesh, false)[0];
    const obj = best.mesh.userData.obj;
    return { obj, point: hit ? hit.point.toArray() : obj.center };
  }

  let pointerDown = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    pointerDown = [e.clientX, e.clientY];
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!pointerDown || Math.hypot(e.clientX - pointerDown[0], e.clientY - pointerDown[1]) > CLICK_TOLERANCE_PX) return;
    const hit = pickAtClient(e.clientX, e.clientY);
    if (hit) onPick(hit.obj, hit.point.map((n) => Math.round(n * 1000) / 1000));
  });

  /** Tegner bare når noe har endret seg (kamera, farger, størrelse), i stedet for en evig
   *  tegnesløyfe som holder skjermkortet i gang uten grunn. */
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderer.render(scene, camera);
    });
  }
  controls.addEventListener("change", requestRender);

  new ResizeObserver(() => {
    const { clientWidth: width, clientHeight: height } = container;
    if (!width || !height) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    requestRender();
  }).observe(container);

  let lastFocusVersion = null;
  function update(state) {
    for (const [guid, mesh] of meshes) {
      const outsideSearch = state.activeSearch && !state.activeSearch.has(guid);
      mesh.visible = !(outsideSearch && state.visualizationMode === "HIDDEN");
      const codedColor = state.colorCoded && state.colorCoded.get(guid);
      if (codedColor) mesh.material = colorMaterial(codedColor);
      else if (state.highlighted.has(guid) || (state.activeSearch && state.activeSearch.has(guid))) mesh.material = highlightMaterial;
      else if (outsideSearch && state.visualizationMode === "FADED") mesh.material = fadedMaterial;
      else mesh.material = normalMaterial(mesh.userData.obj.kind);
    }
    if (state.focusVersion !== lastFocusVersion) {
      lastFocusVersion = state.focusVersion;
      const focus = state.focus.map((guid) => meshes.get(guid)).filter(Boolean);
      if (focus.length) fitTo(focus);
    }
    requestRender();
  }

  fitTo([...pickables, ...contextMeshes]);
  return {
    update,
    fitAll: () => fitTo([...pickables, ...contextMeshes]),
    // For automatisk testing: hva treffer et klikk på (x, y) i andel av visningen (0..1)?
    pickAt: (x, y) => {
      const rect = renderer.domElement.getBoundingClientRect();
      return pickAtClient(rect.left + x * rect.width, rect.top + y * rect.height);
    },
  };
}
