const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const local = path.join(root, '.dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const dotnet = fs.existsSync(local) ? local : 'dotnet';
const dll = path.join(root, 'dist', 'helper', 'oscp-windows-helper.dll');
module.exports = { root, dotnet, dll };
