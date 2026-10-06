"""Export tagged vanilla crafting recipes from a Minecraft client/server jar.

Usage: python scripts/export-crafting-tags.py path/to/1.20.6.jar \
  src/worlds/minecraft/data/crafting-tags-1.20.6.json

The runtime uses these recipes only to choose concrete items for a crafting
grid. The server still decides whether the craft succeeds and what it yields.
"""

import json
import sys
import zipfile
from pathlib import Path


def main(jar_path: str, output_path: str) -> None:
    recipes = {}
    tags = {}
    with zipfile.ZipFile(jar_path) as jar:
        for name in sorted(jar.namelist()):
            if name.startswith("data/minecraft/tags/items/") and name.endswith(".json"):
                tag = name.removeprefix("data/minecraft/tags/items/").removesuffix(".json")
                tags[f"minecraft:{tag}"] = json.loads(jar.read(name))["values"]
            if not (name.startswith("data/minecraft/recipes/") and name.endswith(".json")):
                continue
            recipe = json.loads(jar.read(name))
            if recipe.get("type") not in ("minecraft:crafting_shaped", "minecraft:crafting_shapeless"):
                continue
            if '"tag"' not in json.dumps(recipe):
                continue
            result = recipe["result"]["id"].removeprefix("minecraft:")
            kept = {key: recipe[key] for key in ("type", "pattern", "key", "ingredients", "result") if key in recipe}
            recipes.setdefault(result, []).append(kept)
    output = {"version": Path(jar_path).stem, "recipes": recipes, "tags": tags}
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Exported {sum(map(len, recipes.values()))} tagged recipes and {len(tags)} item tags to {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: export-crafting-tags.py <minecraft.jar> <output.json>")
    main(sys.argv[1], sys.argv[2])
