// Ensure dist-electron is treated as CommonJS
// (needed because root package.json has "type": "module")
const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'dist-electron', 'package.json')
fs.writeFileSync(target, JSON.stringify({ type: 'commonjs' }, null, 2))
console.log('[postcompile] Created dist-electron/package.json with type:commonjs')
