import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(directory, '.env');
if (fs.existsSync(destination)) {
  console.log('Ya existe .env. Se conserva su configuración.');
} else {
  let template = fs.readFileSync(path.join(directory, '.env.example'), 'utf8');
  template = template.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`);
  template = template.replace(/^BOOTSTRAP_PASSWORD=.*$/m, `BOOTSTRAP_PASSWORD=${crypto.randomBytes(18).toString('base64url')}`);
  fs.writeFileSync(destination, template, { mode:0o600, flag:'wx' });
  console.log('Configuración creada en .env. Usuario inicial: supervisor. Consulta BOOTSTRAP_PASSWORD en ese archivo para iniciar sesión.');
}
