// Diagnostic: does a bare /clone round-trip to the far-away vault actually work?
import { Rcon } from '../src/rcon.js';

const rcon = new Rcon({ host: 'mc', port: 25575, password: process.env.RCON_PASSWORD });
await rcon.connect();

const T = { x: 9000, y: 100, z: 9000 };
const V = { x: 1000000, y: -60, z: 1000000 };
const send = async (c) => {
  const r = await rcon.send(c);
  console.log('  >', c.slice(0, 72).padEnd(72), '=>', r.trim().slice(0, 70));
  return r;
};

await send(`forceload add ${T.x - 16} ${T.z - 16} ${T.x + 16} ${T.z + 16}`);
await send(`forceload add ${V.x - 16} ${V.z - 16} ${V.x + 16} ${V.z + 16}`);
await new Promise((r) => setTimeout(r, 3000));

console.log('\n-- set up source --');
await send(`fill ${T.x} ${T.y} ${T.z} ${T.x + 3} ${T.y + 3} ${T.z + 3} air`);
await send(`setblock ${T.x + 1} ${T.y + 1} ${T.z + 1} emerald_block`);

console.log('\n-- snapshot source -> vault --');
await send(`clone ${T.x} ${T.y} ${T.z} ${T.x + 3} ${T.y + 3} ${T.z + 3} ${V.x} ${V.y} ${V.z}`);
await send(`execute if block ${V.x + 1} ${V.y + 1} ${V.z + 1} emerald_block run say VAULT_HAS_EMERALD`);

console.log('\n-- overwrite source --');
await send(`fill ${T.x} ${T.y} ${T.z} ${T.x + 3} ${T.y + 3} ${T.z + 3} netherrack`);

console.log('\n-- restore vault -> source --');
await send(`clone ${V.x} ${V.y} ${V.z} ${V.x + 3} ${V.y + 3} ${V.z + 3} ${T.x} ${T.y} ${T.z}`);
await send(`execute if block ${T.x + 1} ${T.y + 1} ${T.z + 1} emerald_block run say RESTORED_EMERALD`);
await send(`execute if block ${T.x} ${T.y} ${T.z} air run say RESTORED_AIR`);

console.log('\n-- cleanup --');
await send(`fill ${T.x} ${T.y} ${T.z} ${T.x + 3} ${T.y + 3} ${T.z + 3} air`);
await send(`forceload remove ${T.x - 16} ${T.z - 16} ${T.x + 16} ${T.z + 16}`);
await send(`forceload remove ${V.x - 16} ${V.z - 16} ${V.x + 16} ${V.z + 16}`);
rcon.close();
