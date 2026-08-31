// Local stand-in for Vercel's /api routing — mounts every file in api/ at
// /api/<filename> so handlers can be written once and run the same way
// locally and in production.
import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local') });
const apiDir = path.join(__dirname, 'api');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

for (const file of readdirSync(apiDir)) {
  if (!file.endsWith('.js')) continue;
  const route = `/api/${file.replace(/\.js$/, '')}`;
  const mod = await import(pathToFileURL(path.join(apiDir, file)).href);
  app.get(route, (req, res) => mod.default(req, res));
  console.log(`[dev-server] ${route}`);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[dev-server] listening on http://localhost:${PORT}`));
