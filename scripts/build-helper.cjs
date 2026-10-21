const { spawnSync } = require('node:child_process');
const { root, dotnet } = require('./helper-runtime.cjs');
const result = spawnSync(dotnet, ['build', 'src/Oscp.Helper/Oscp.Helper.csproj', '-c', 'Release', '-o', 'dist/helper'], { cwd: root, stdio: 'inherit' });
if (result.error) console.error('Install .NET 8 SDK or use a project-local .dotnet SDK:', result.error.message);
process.exit(result.status ?? 1);
