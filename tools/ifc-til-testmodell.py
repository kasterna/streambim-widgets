"""Gjør en armerings-IFC om til en testmodell for den lokale StreamBIM-etterligningen.

Bruk:
    python tools/ifc-til-testmodell.py ARM.ifc [--kontekst KON.ifc] [--navn mitt-prosjekt]

Skriver dev/models/<navn>.json (forenklet geometri + egenskapssett per objekt) og
oppdaterer dev/models/index.json, som mock-host.html leser for å vise modellvelgeren.
dev/models/ er i .gitignore — prosjektmodeller skal aldri inn i det offentlige repoet.
"""

import argparse
import json
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element

MODELS_DIR = Path(__file__).resolve().parent.parent / "dev" / "models"
# Grov tessellering: armering er tynne rør, og full kvalitet gir ~660k trekanter for 250 objekter.
ANGULAR_DEFLECTION = 1.4
LINEAR_DEFLECTION = 0.005
DECIMALS = 4  # 0,1 mm i meter
PICKABLE_CLASSES = ("IfcReinforcingBar", "IfcReinforcingMesh", "IfcTendon")


def geometry_settings() -> ifcopenshell.geom.settings:
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    settings.set("mesher-angular-deflection", ANGULAR_DEFLECTION)
    settings.set("mesher-linear-deflection", LINEAR_DEFLECTION)
    return settings


def mesh_for(settings: ifcopenshell.geom.settings, element: ifcopenshell.entity_instance) -> dict | None:
    """Returnerer {v, f} i meter, eller None hvis elementet ikke har geometri."""
    try:
        geometry = ifcopenshell.geom.create_shape(settings, element).geometry
    except RuntimeError:
        return None
    verts = [round(x, DECIMALS) for x in geometry.verts]
    return {"v": verts, "f": list(geometry.faces)} if verts else None


def center_of(verts: list[float]) -> list[float]:
    xs, ys, zs = verts[0::3], verts[1::3], verts[2::3]
    return [round((min(axis) + max(axis)) / 2, DECIMALS) for axis in (xs, ys, zs)]


def psets_for(element: ifcopenshell.entity_instance) -> dict[str, dict]:
    """Alle egenskapssett uten ifcopenshell sine interne "id"-felt."""
    return {
        name: {key: value for key, value in props.items() if key != "id"}
        for name, props in ifcopenshell.util.element.get_psets(element).items()
    }


def read_objects(path: Path, settings: ifcopenshell.geom.settings) -> list[dict]:
    model = ifcopenshell.open(str(path))
    objects = []
    for element in (e for cls in PICKABLE_CLASSES for e in model.by_type(cls)):
        mesh = mesh_for(settings, element)
        if not mesh:
            continue
        objects.append({
            "guid": element.GlobalId,
            "name": element.Name or element.is_a(),
            "kind": element.is_a()[3:],  # samme form som StreamBIM sin @kind: uten "Ifc"
            "psets": psets_for(element),
            "center": center_of(mesh["v"]),
            "mesh": mesh,
        })
    return objects


def read_context(path: Path, settings: ifcopenshell.geom.settings) -> list[dict]:
    """Betong o.l. som bakgrunn: bare geometri, kan ikke klikkes."""
    model = ifcopenshell.open(str(path))
    context = []
    for element in model.by_type("IfcElement"):
        if element.is_a("IfcOpeningElement"):
            continue
        mesh = mesh_for(settings, element)
        if mesh:
            context.append({"guid": element.GlobalId, "kind": element.is_a()[3:], "mesh": mesh})
    return context


def update_index(name: str, label: str) -> None:
    index_path = MODELS_DIR / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    index = [entry for entry in index if entry["file"] != f"{name}.json"]
    index.append({"file": f"{name}.json", "label": label})
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("arm", type=Path, help="IFC med armering (klikkbare objekter)")
    parser.add_argument("--kontekst", type=Path, help="IFC med betong o.l. som vises gjennomsiktig")
    parser.add_argument("--navn", help="filnavn uten .json (standard: navnet på ARM-filen)")
    args = parser.parse_args()

    settings = geometry_settings()
    objects = read_objects(args.arm, settings)
    if not objects:
        raise SystemExit(f"Fant ingen armering med geometri i {args.arm}")
    context = read_context(args.kontekst, settings) if args.kontekst else []

    name = args.navn or args.arm.stem.lower().replace(" ", "-")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    out = MODELS_DIR / f"{name}.json"
    payload = {"source": args.arm.name, "units": "m", "objects": objects, "context": context}
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    update_index(name, args.arm.stem)

    triangles = sum(len(o["mesh"]["f"]) // 3 for o in objects + context)
    size_mb = out.stat().st_size / 1_000_000
    print(f"{out}: {len(objects)} armeringsobjekter, {len(context)} kontekstobjekter, {triangles} trekanter, {size_mb:.1f} MB")


if __name__ == "__main__":
    main()
