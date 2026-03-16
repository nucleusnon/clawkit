import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve('src/security/graylist.json');
const destination = resolve('dist/security/graylist.json');

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
