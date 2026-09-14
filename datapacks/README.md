# Datapacks

Vanilla datapacks for the server. They run on Paper as-is; nothing to compile.

| Pack | What it does |
|---|---|
| `bedrockreach` | Sets every player's `block_interaction_range` to 12, every 5 seconds. iPad/Bedrock players reach about 12 blocks in creative; without this the server rejects their breaks beyond about 6 and the block reappears. |
| `tntcastle` | `function tntcastle:build` builds a TNT castle with a lever detonator. Run it in the TNT world and run it again to rebuild after a blast. |

Install by copying a pack folder into the world's datapacks and reloading.
From a Mac, stop tar from adding `._*` AppleDouble files, which the server
then tries (and fails) to load as functions:

```bash
COPYFILE_DISABLE=1 tar -C datapacks -cf - bedrockreach \
  | ssh <host> 'docker exec -i -u minecraft minecraft tar -C /data/world/datapacks -xf -'
./scripts/mc cmd "minecraft:reload"
./scripts/mc cmd "execute in minecraft:tntworld run function tntcastle:build"
```

Keep TNT out of the main world with a per-world rule, and give it a world of its own:

```bash
./scripts/mc cmd "execute in minecraft:overworld run gamerule tnt_explodes false"
./scripts/mc cmd "mv create tntworld NORMAL --world-type FLAT"
```
