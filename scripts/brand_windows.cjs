const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

module.exports = async function brandWindows(context) {
  if (context.electronPlatformName !== 'win32') return;
  const projectRequire = createRequire(path.join(context.packager.projectDir, 'package.json'));
  const { NtExecutable, NtExecutableResource, Data, Resource } = projectRequire('resedit');
  const product = context.packager.appInfo.productFilename;
  const version = context.packager.appInfo.version;
  const executablePath = path.join(context.appOutDir, `${product}.exe`);
  const executable = NtExecutable.from(await fs.readFile(executablePath), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const icons = Data.IconFile.from(await fs.readFile(path.join(__dirname, '../desktop/icon.ico')));
  const groups = resources.entries.filter((entry) => entry.type === 14);
  if (!groups.length) throw new Error('Windows executable icon resource is missing.');
  for (const group of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons.icons.map((icon) => icon.data));
  }
  for (const info of Resource.VersionInfo.fromEntries(resources.entries)) {
    info.setFileVersion(...version.split('.').map(Number), 0, 1033);
    info.setProductVersion(...version.split('.').map(Number), 0, 1033);
    info.setStringValues({ lang: 1033, codepage: 1200 }, {
      FileDescription: product, ProductName: product, CompanyName: 'PrimeOps',
      InternalName: product, OriginalFilename: `${product}.exe`, LegalCopyright: ''
    });
    info.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);
  await fs.writeFile(executablePath, Buffer.from(executable.generate()));
};
