import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../lib/workbook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function include(relative) {
  const absolute = path.join(root, relative);
  if (fs.statSync(absolute).isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) if (name !== '.DS_Store') include(path.join(relative,name));
  } else files.push([`brumap-inventario/${relative.replaceAll(path.sep,'/')}`,fs.readFileSync(absolute)]);
}
for (const item of ['Dockerfile','docker-compose.yml','package.json','package-lock.json','server.js','README.md','.env.example','.gitignore','.dockerignore','lib','public','scripts','test']) include(item);
const output = path.join(root, 'release', 'brumap-inventario-docker.zip');
fs.mkdirSync(path.dirname(output), { recursive:true });
fs.writeFileSync(output, createZip(files));
console.log(`Paquete creado: ${output} (${files.length} archivos). No contiene bases de datos ni secretos.`);
