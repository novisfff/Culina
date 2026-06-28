import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const stylesDir = path.resolve(process.cwd(), 'src/styles');
const patterns = [
  { id: 'radius-13px', label: 'border-radius: 13px', regex: /border-radius:\s*13px/g },
  { id: 'radius-17px', label: 'border-radius: 17px', regex: /border-radius:\s*17px/g },
  { id: 'black-rgba', label: 'rgba(0, 0, 0, ...)', regex: /rgba\(0,\s*0,\s*0,\s*[^)]+\)/g },
];

async function listCssFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listCssFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.css') ? [fullPath] : [];
  }));
  return nested.flat();
}

function lineNumberForIndex(content, index) {
  return content.slice(0, index).split('\n').length;
}

const files = await listCssFiles(stylesDir);
const hits = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern.regex)) {
      hits.push({
        pattern: pattern.label,
        file: path.relative(process.cwd(), file),
        line: lineNumberForIndex(content, match.index ?? 0),
        value: match[0],
      });
    }
  }
}

const byPattern = new Map();
for (const hit of hits) {
  byPattern.set(hit.pattern, (byPattern.get(hit.pattern) ?? 0) + 1);
}

console.log('Style token drift report');
console.log(`Scanned ${files.length} CSS files. Found ${hits.length} report-only matches.`);
for (const pattern of patterns) {
  console.log(`- ${pattern.label}: ${byPattern.get(pattern.label) ?? 0}`);
}

if (hits.length > 0) {
  console.log('\nFirst matches:');
  for (const hit of hits.slice(0, 40)) {
    console.log(`- ${hit.file}:${hit.line} ${hit.value}`);
  }
}
