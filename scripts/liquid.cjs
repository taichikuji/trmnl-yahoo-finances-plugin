// Development-only equivalents of the native TRMNL filters used by our views.
const { randomUUID } = require('node:crypto');
const { Liquid } = require('liquidjs');
function createLiquid() {
  const snippets = new Map();
  const liquid = new Liquid({ strictFilters: true, relativeReference: false, fs: {
    resolve: (_, file) => file,
    exists: file => snippets.has(file), existsSync: file => snippets.has(file),
    readFile: file => snippets.get(file), readFileSync: file => snippets.get(file)
  } });
  // TRMNL registers Shared template blocks as isolated Liquid render partials.
  liquid.registerTag('template', {
    parse(tag, tokens) {
      const stream = this.liquid.parser.parseStream(tokens)
        .on('tag:endtemplate', end => {
          snippets.set(tag.args.trim(), tag.input.slice(tag.end, end.begin));
          stream.stop();
        }).on('end', () => { throw new Error('Unclosed Shared template'); });
      stream.start();
    },
    render() {}
  });
  liquid.registerFilter('append_random', value => String(value) + randomUUID().replaceAll('-', ''));
  return liquid;
}
module.exports = { createLiquid };
