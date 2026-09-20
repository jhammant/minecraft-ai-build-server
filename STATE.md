# Minecraft AI build server — state as of 2026-09-20

## What this is

A family Minecraft server (Paper 26.1.2 on the home server `endor`, deployed with
docker compose) with a web panel and an AI build assistant. The kids play on iPads
(Bedrock, via Geyser/Floodgate).

## Where it stands

A real session with three kids exposed a lot, and the fixes are **live on the server**
and pushed to **PR #1** (open, not merged): <https://github.com/jhammant/minecraft-ai-build-server/pull/1>

Done and verified on the live server:

- **Builder**: real doors and beds, animals and fish (tagged, removed by undo), block-id
  correction plus a pre-build check against the server, per-request size budgets,
  foundations instead of stilts, a details pass for torches/lanterns.
- **RCON**: the panel's status poll used to collide with a build's command and the server
  hung up mid-build. One request on the wire at a time; force-loads always released.
- **Builds over water** went on the lake bed (water is in `#minecraft:replaceable`), and
  their door openings filled with water. They now sit on the water on a plinth.
- **Flatten** raised a sand tower on small sites; fixed.
- Tests: 159 passing (was 80).
- **Server**: memory cap 5 GB -> 6 GB; TNT damage rolled back with CoreProtect; TNT
  disabled in the main world; a flat `tntworld` with a rebuildable TNT castle
  (`function tntcastle:build`); portal pads between all three worlds; a `bedrockreach`
  datapack raising block reach to 12 for iPad players; kids added to the LuckPerms
  `builder` group; the Mosslorn city map imported as its own world.

Not verified (needs a kid actually playing):

- the reach fix (break a block ~8 away), the portal pads with a real player, `/mvtp`
  typed by a kid, the panel on an iPad home screen.

## Next steps

1. Watch one kid play and confirm those four.
2. Merge PR #1 (or review it first — it is large).
3. Decide on the open questions below.

## Open questions

- The `builder` group can **create worlds**; each one costs memory on a RAM-tight box.
  Remove that permission?
- TNT is still enabled in the Mosslorn world. Leave it?
- The drop-an-item-on-a-crafting-table uncrafting datapack is installed on the server but
  deliberately **not** in this repo: it is derived from an All Rights Reserved pack. A
  clean version could be generated from Minecraft's own recipe files.

## Ideas worth keeping

- **Verify by effect, not by reply.** Plugin commands (LuckPerms, CoreProtect, Floodgate)
  answer asynchronously and RCON returns nothing, so check the artefact instead: the
  plugin's own database, or `lp export`. This caught three "successful" no-ops.
- **Scan the world, not the logs, to know whether a build worked.** "3 doors placed" in a
  record meant nothing; probing every block in the build's region found zero doors and
  led to the underwater bug.
- **A fake world in tests.** Modelling ground height and water in the RCON stub
  reproduced the lake bug offline in two tests before touching the server.

---
_Updated by `forkcode close` on 2026-09-20T21:51+01:00_
