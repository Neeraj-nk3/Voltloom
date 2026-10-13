// Prints the link that opens a project file in Voltloom.
//
//   node scripts/share-link.mjs examples/projects/python-blink.project.json [baseUrl]
//
// baseUrl defaults to the development server, http://localhost:5173/. The project is validated first, exactly as the app
// validates a link it receives, so a file that would be rejected is reported here instead of in the browser.
import fs from 'node:fs';
import { encodeProject, decodeProject, getLastImportError } from '../src/project/project-store.js';

const [file, baseUrl = 'http://localhost:5173/'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/share-link.mjs <project.json> [baseUrl]');
  process.exit(2);
}

let project;
try {
  project = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(1);
}

const encoded = encodeProject(project);
if (!decodeProject(encoded)) {
  console.error(`the app would reject this project: ${getLastImportError()}`);
  process.exit(1);
}
const url = new URL(baseUrl);
url.searchParams.set('p', encoded);
console.log(url.toString());
