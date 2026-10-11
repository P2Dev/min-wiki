import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, acquireLock } from './store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const [command, name = 'Local administrator'] = process.argv.slice(2);
if (!['init', 'key:create'].includes(command)) { console.error('Usage: npm run init | npm run key:create -- "Administrator name"'); process.exitCode = 1; }
else {
  let release;
  try {
    release = await acquireLock(directory);
    const store = new Store(directory); await store.init();
    if (command === 'init') {
      if ((await store.keys()).length) throw new Error('Already initialized. To recover access, stop the service and run npm run key:create.');
      for (const file of await readdir(path.join(root, 'examples'))) {
        if (!file.endsWith('.md')) continue;
        try { await store.create(file.slice(0, -3), await readFile(path.join(root, 'examples', file), 'utf8')); }
        catch (error) { if (error.code !== 'page_exists') throw error; }
      }
    }
    const key = await store.issueKey(name, 'admin');
    console.log('Save this administrator key in your password manager. It will not be shown again.');
    console.log(key.secret);
    console.log('Start the service with npm start. Use the admin API to issue a separate writer key for each client.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (release) await release(); }
}
