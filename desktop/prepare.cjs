const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', 'www');
const target = path.join(__dirname, 'www');
if (!fs.existsSync(path.join(source, 'app.bundle.js'))) {
  throw new Error('Run "npm run build" in the project root first.');
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log('Copied www into desktop/www');
