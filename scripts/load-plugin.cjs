// Development harness: run the exact importable script without adding exports
// or Node-only code to TRMNL's Serverless source.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadPlugin(overrides = {}) {
  const sandbox = {
    fetch, AbortController, TextEncoder, setTimeout, clearTimeout, ...overrides
  };
  const source = fs.readFileSync(path.join(__dirname, '../TRMNL/src/transform.js'), 'utf8');
  vm.runInNewContext(source + '\nthis.plugin = { run, chart, parseYahoo, validState, bytes };', sandbox);
  return sandbox.plugin;
}

module.exports = { loadPlugin };
