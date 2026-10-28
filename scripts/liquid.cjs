// Development-only equivalents of the native TRMNL filters used by our views.
const { randomUUID } = require('node:crypto');
const { Liquid } = require('liquidjs');
function createLiquid() {
  const liquid = new Liquid({ strictFilters: true });
  liquid.registerFilter('append_random', value => String(value) + randomUUID().replaceAll('-', ''));
  return liquid;
}
module.exports = { createLiquid };
