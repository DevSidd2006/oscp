// Explicit opt-in: inspects connected Windows storage metadata without writing to devices.
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { root, dotnet, dll } = require('../../scripts/helper-runtime.cjs');
const name = 'oscp-test-' + randomUUID();
const helper = spawn(dotnet, [process.env.OSCP_SMOKE_HELPER_DLL || dll, '--pipe', name], { cwd: root, windowsHide: true });
let output = '';
let errors = '';
helper.stdout.on('data', data => { output += data; });
helper.stderr.on('data', data => { errors += data; });
const deadline = setTimeout(() => { helper.kill(); console.error('Helper test timed out:', errors); process.exit(1); }, 60000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const socket = net.createConnection('\\\\.\\pipe\\' + name);
    try { await once(socket, 'connect'); return socket; }
    catch { socket.destroy(); await delay(50); }
  }
  throw new Error('Helper did not listen: ' + errors);
}
async function session(callback) {
  const socket = await connect();
  socket.setEncoding('utf8');
  let buffer = '';
  const replies = [];
  socket.on('data', data => {
    buffer += data;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      replies.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1);
    }
  });
  async function request(request) {
    socket.write(JSON.stringify({ protocolVersion: '1.0', requestId: randomUUID(), command: 'storage.enumerate',
      timestampUtc: new Date().toISOString(), client: { name: 'oscp-test', version: '0.1.0' }, arguments: {}, ...request }) + '\n');
    while (!replies.length) { if (socket.destroyed) throw new Error('Connection closed'); await delay(10); }
    return replies.shift();
  }
  try { await callback(request); } finally { socket.destroy(); }
}
(async () => {
  assert.equal(process.platform, 'win32');
  await session(async request => {
    assert.equal((await request({ command: 'erase' })).error.code, 'UNSUPPORTED_COMMAND');
    assert.equal((await request({ arguments: { includeVolumes: 'yes' } })).error.code, 'VALIDATION_ERROR');
    assert.equal((await request({ protocolVersion: '9.0' })).error.code, 'UNSUPPORTED_COMMAND');
    const requestId = randomUUID();
    await request({ requestId, command: 'unknown' });
    assert.equal((await request({ requestId })).error.code, 'DUPLICATE_REQUEST');
    const result = await request({ arguments: { includePartitions: true, includeVolumes: true } });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    for (const disk of result.result.devices) {
      assert.match(disk.id, /^disk:[0-9a-f]{64}$/);
      assert.ok(disk.capacityBytes >= 0);
      assert.ok(['ReadOnly', 'Unavailable'].includes(disk.accessMode));
      assert.ok(!disk.id.includes('PhysicalDrive'));
      for (const partition of disk.partitions) assert.ok(partition.offsetBytes + partition.sizeBytes <= disk.capacityBytes);
    }
    console.log(`Windows storage: ${result.result.devices.length} real disk(s); partitions and volumes validated.`);
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'oscp-resolve-'));
    const tempFile = path.join(tempDirectory, 'existing.txt');
    fs.writeFileSync(tempFile, 'Resolver test fixture only.');
    try {
      const resolve = selectedPath => request({ command: 'storage.resolvePath', arguments: { path: selectedPath } });
      let directoryLocation;
      for (const [selectedPath, kind] of [[tempDirectory, 'directory'], [tempFile, 'file']]) {
        const resolved = await resolve(selectedPath);
        assert.equal(resolved.ok, true, JSON.stringify(resolved.error));
        const location = resolved.result.location;
        assert.equal(location.kind, kind);
        assert.match(location.canonicalPath, /^\\\\\?\\Volume\{/i);
        const selectedStat = fs.statSync(selectedPath, { bigint: true });
        const canonicalStat = fs.statSync(location.canonicalPath, { bigint: true });
        assert.equal(canonicalStat.dev, selectedStat.dev);
        assert.equal(canonicalStat.ino, selectedStat.ino);
        assert.ok(Number.isSafeInteger(location.freeBytes) && location.freeBytes >= 0);
        assert.ok(location.physicalDeviceIds.length > 0);
        const revalidated = await resolve(location.canonicalPath);
        assert.equal(revalidated.ok, true, JSON.stringify(revalidated.error));
        assert.equal(revalidated.result.location.canonicalPath, location.canonicalPath);
        assert.deepEqual(revalidated.result.location.physicalDeviceIds, location.physicalDeviceIds);
        for (const id of location.physicalDeviceIds) assert.ok(result.result.devices.some(disk => disk.id === id));
        if (directoryLocation) assert.deepEqual(location.physicalDeviceIds, directoryLocation.physicalDeviceIds);
        else directoryLocation = location;
      }
      const alias = path.join(tempDirectory, 'directory-alias');
      fs.symlinkSync(tempDirectory, alias, 'junction');
      try {
        const aliased = await resolve(alias);
        assert.equal(aliased.ok, true, JSON.stringify(aliased.error));
        assert.equal(aliased.result.location.canonicalPath, directoryLocation.canonicalPath);
        assert.deepEqual(aliased.result.location.physicalDeviceIds, directoryLocation.physicalDeviceIds);
      } finally { fs.rmdirSync(alias); }
      const volumeRoot = directoryLocation.canonicalPath.split('}')[0] + '}\\';
      const resolvedRoot = await resolve(volumeRoot);
      assert.equal(resolvedRoot.ok, true, JSON.stringify(resolvedRoot.error));
      assert.equal(resolvedRoot.result.location.kind, 'directory');
      assert.equal(resolvedRoot.result.location.canonicalPath, volumeRoot);
      assert.deepEqual(resolvedRoot.result.location.physicalDeviceIds, directoryLocation.physicalDeviceIds);
      for (const invalid of [path.join(tempDirectory, 'missing'), tempFile + ':stream', '\\\\.\\PhysicalDrive0', 'relative.txt',
        '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1', volumeRoot.slice(0, -1),
        directoryLocation.canonicalPath + ':stream']) {
        const rejected = await resolve(invalid);
        assert.equal(rejected.ok, false);
        assert.equal(rejected.error.code, 'VALIDATION_ERROR');
      }
      assert.equal((await request({ command: 'storage.resolvePath', arguments: { path: 10 } })).error.code, 'VALIDATION_ERROR');
      console.log('Existing file/directory backing identities match enumeration; invalid and missing paths refused.');
    } finally {
      fs.unlinkSync(tempFile);
      fs.rmdirSync(tempDirectory);
    }
    const without = await request({ arguments: { includePartitions: false, includeVolumes: false } });
    assert.equal(without.ok, true, JSON.stringify(without.error));
    assert.ok(without.result.devices.every(d => d.partitions.length === 0));
  });
  await session(async request => assert.equal((await request({ command: 'unknown' })).error.code, 'UNSUPPORTED_COMMAND'));
  console.log('Helper protocol validation, duplicate IDs, boolean arguments, and reconnect checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearTimeout(deadline); helper.kill(); });
