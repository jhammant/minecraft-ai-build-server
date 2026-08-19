// Run server console commands over RCON and print the replies.
//   docker exec minecraft-ai-builder node test/rcon-run.mjs "lp listgroups" "whitelist list"
import { Rcon } from '../src/rcon.js';

const rcon = new Rcon({
  host: process.env.RCON_HOST || 'mc',
  port: Number(process.env.RCON_PORT || 25575),
  password: process.env.RCON_PASSWORD,
});
await rcon.connect();
for (const cmd of process.argv.slice(2)) {
  const res = await rcon.send(cmd);
  console.log(`$ ${cmd}\n${res.replace(/§[0-9a-fk-or]/g, '').trim() || '(no output)'}\n`);
}
rcon.close();
