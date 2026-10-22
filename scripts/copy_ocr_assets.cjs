const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const destination = path.join(root, 'www', 'assets', 'tesseract');
const workerPackage = path.dirname(require.resolve('tesseract.js/package.json'));
const corePackage = path.dirname(require.resolve('tesseract.js-core/package.json'));
const languagePackage = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.join(destination, 'core'), { recursive: true });
fs.mkdirSync(path.join(destination, 'lang'), { recursive: true });

fs.copyFileSync(path.join(workerPackage, 'dist', 'worker.min.js'), path.join(destination, 'worker.min.js'));
for (const suffix of ['simd-lstm', 'lstm']) {
  for (const extension of ['wasm.js', 'wasm']) {
    const filename = `tesseract-core-${suffix}.${extension}`;
    fs.copyFileSync(path.join(corePackage, filename), path.join(destination, 'core', filename));
  }
}
fs.copyFileSync(
  path.join(languagePackage, '4.0.0_best_int', 'eng.traineddata.gz'),
  path.join(destination, 'lang', 'eng.traineddata.gz')
);
