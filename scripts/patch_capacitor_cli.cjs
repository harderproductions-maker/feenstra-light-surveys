const fs = require('node:fs');
const path = require('node:path');

const cliEntry = require.resolve('@capacitor/cli');
const templatePath = path.join(path.dirname(cliEntry), 'util', 'template.js');
const source = fs.readFileSync(templatePath, 'utf8');
const defaultImport = 'const tar_1 = tslib_1.__importDefault(require("tar"));';
const namedImport = 'const tar_1 = require("tar");';
const defaultCall = 'tar_1.default.extract';

if (source.includes(namedImport) && source.includes('tar_1.extract')) {
  process.exit(0);
}

if (!source.includes(defaultImport) || !source.includes(defaultCall)) {
  throw new Error(`Unexpected Capacitor CLI tar import in ${templatePath}`);
}

const patched = source.replace(defaultImport, namedImport).replace(defaultCall, 'tar_1.extract');
fs.writeFileSync(templatePath, patched);