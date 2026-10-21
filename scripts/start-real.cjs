const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { root, dotnet, dll } = require('./helper-runtime.cjs');
if (process.platform !== 'win32') throw new Error('Real storage inspection requires Windows. Use npm start for demo mode.');
if (!fs.existsSync(dll)) throw new Error('Build the helper first: npm run build:helper');
let desktop;
let helperOutput = '';
const helper = spawn(dotnet, [dll], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
const timer = setTimeout(() => { console.error('Helper did not become ready.'); cleanup(1); }, 15000);
helper.on('error', error => { console.error(error.message); cleanup(1); });
helper.on('exit', code => { if (!desktop) cleanup(code || 1); else desktop.kill(); });
helper.stdout.on('data', data => {
  process.stdout.write(data);
  helperOutput = (helperOutput + data.toString()).slice(-4096);
  if (!desktop && helperOutput.includes('waiting for client connection')) {
    clearTimeout(timer);
    const environment = { ...process.env, OSCP_DATA_MODE: 'helper' };
    delete environment.ELECTRON_RUN_AS_NODE;
    desktop = spawn(require('electron'), ['.'], { cwd: root, windowsHide: false,
      env: environment, stdio: 'inherit' });
    desktop.on('error', error => { console.error(error.message); cleanup(1); });
    desktop.on('exit', code => cleanup(code || 0));
  }
});
function cleanup(code) { clearTimeout(timer); helper.kill(); desktop?.kill(); process.exit(code); }
process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
