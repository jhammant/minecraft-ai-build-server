# Getting people onto the server

## The two settings people confuse

They do different jobs and you want both on:

- **`online-mode=true`** — every joining player is cryptographically verified
  against Microsoft's auth servers. Nobody can pretend to be someone else. This
  is what makes exposing a port tolerable at all.
- **`white-list=true`** — only listed accounts may join. Everyone else bounces
  off with *"You are not white-listed on this server!"*

Port 25565 is mass-scanned continuously and open servers are indexed publicly —
an unwhitelisted server typically gets found within hours, and then you're
restoring backups weekly. Keep the whitelist on.

## Making it easy anyway

The friction people hate is having to ask an adult to add each friend. So don't:
your kid can add their own.

They're in the LuckPerms `builder` group, which grants exactly
`minecraft.command.whitelist` (and the Multiverse world commands) — **not** full
op, so no `/ban`, `/stop`, `/gamemode`.

The flow is:

> **Friend:** what's the address?
> **Kid:** `mc.example.com` — then types `/whitelist add TheirUsername` in chat
> **Friend:** joins

About ten seconds, no adult involved.

To put your kid in the group (once, from your Mac):

```bash
./scripts/mc cmd "lp user <KidUsername> parent add builder"
```

To add someone yourself:

```bash
./scripts/mc whitelist add <name>
./scripts/mc whitelist list
```

### Bedrock players

Geyser/Floodgate players authenticate against Xbox Live and appear with a `.`
prefix, e.g. `.BedrockKid`. Whitelist them with the prefix included.

## Exposing the server

Three things to do. Only the first is strictly required.

### 1. Forward the port on your router

| Setting | Value |
|---|---|
| Protocol | TCP |
| External port | 25565 |
| Internal host | `<your server's LAN IP>` |
| Internal port | 25565 |

For Bedrock clients, also forward **UDP 19132** to the same host.

### 2. Point a name at your home IP

Home connections get a changing IP, so point a name at it with a dynamic-DNS
updater (ddclient, ddns-route53, your registrar's own client — anything that
refreshes an A record). Then friends type a name instead of digits.

### 3. Optional: an SRV record, so nobody types a port

If you ever move off the default port, a DNS **SRV** record lets friends still
type just `mc.example.com`. The Minecraft client looks up
`_minecraft._tcp.<name>` before connecting and follows it to the real host and
port — which is why big servers never make you type `:25565`.

```text
Name:     _minecraft._tcp.mc.example.com
Type:     SRV
Value:    0 5 25565 mc.example.com
          ^ ^ ^     ^
          │ │ │     └── target host
          │ │ └──────── port
          │ └────────── weight
          └──────────── priority
```

Only useful with a non-default port; on 25565 the client finds it anyway.

## The safer alternative, if you change your mind

A mesh VPN like [Tailscale](https://tailscale.com) reaches the server with **no
port forwarding at all** — install it on the server and on each player's device,
and they connect to its VPN address. For family devices that's strictly better:
nothing public, direct encrypted connections. You can mix both — VPN for family,
whitelisted public port for friends.

## If something goes wrong

```bash
./scripts/mc status            # is it up? who's online?
./scripts/mc logs              # server log
./scripts/mc cmd "co rollback u:<griefer> t:1h r:30"   # undo someone's damage
./scripts/mc backups           # rolling backups, 14 days
```

CoreProtect logs every block change by every player, so griefing is a rollback,
not a restore-from-backup.
