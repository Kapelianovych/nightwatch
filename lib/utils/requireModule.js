const path = require('path');
const {cwd} = require('process');
const {Script} = require('vm');

const {build} = require('esbuild');

const requireModule = function (fullpath) {
  let exported;
  try {
    exported = require(fullpath);
  } catch (err) {
    if (err.code !== 'ERR_REQUIRE_ESM') {
      throw err;
    }

    return import(fullpath).then(result => (result.default || {}));
  }

  if (exported && Object.prototype.hasOwnProperty.call(exported, 'default')) {
    return exported.default;
  }

  return exported;
}

/** Default _esbuild_ loaders matching file extensions. */
const ESBUILD_LOADERS = Object.freeze({
  '.js': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',

  '.ts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',

  '.css': 'css',

  '.json': 'json',

  '.txt': 'text',
  '.data': 'binary',

  '.svg': 'dataurl',
  '.png': 'dataurl',
  '.jpeg': 'dataurl',
  '.webp': 'dataurl',
  '.avif': 'dataurl',
});

/**
 * In opposite to the _requireModule_ this function does not load
 * module directly. Instead, it reads the source of the file and compile it
 * by using a loader based on the module extension.
 *
 * Execution of the transpiled module accomplishes in the separate VM instance
 * with the current global context, so _describe_, _it_ etc. are preserved.
 *
 * Some pseudo-global values are preserved in the context:
 *  1. `__filename`.
 *  2. `__dirname`.
 *  3. `require` (patched).
 *
 * See https://nodejs.org/api/modules.html#the-module-scope
 *
 * That function must not be used for compiling ES modules, because
 * theirs execution in the _vm_ is still [experimental](https://nodejs.org/dist/latest-v16.x/docs/api/vm.html#class-vmmodule)
 * TODO: review it after the API stabilization.
 *
 * @template [T=object]
 * @param {string} modulePath - the full path of the module to be loaded,
 *  compiled and executed.
 * @returns {Promise<T>} the module exported values.
 */
const requireCompiledModule = async function (modulePath) {
  const { outputFiles: [{ text }] } = await build({
    write: false,
    format: 'cjs',
    loader: ESBUILD_LOADERS,
    bundle: true,
    target: ['node12'],
    platform: 'node',
    entryPoints: [modulePath],
  });

  const contextModule = {
    exports: {}
  };

  new Script(`
    (function (module, require, __filename, __dirname) {
      var exports = module.exports;
      ${text}
    })
    `,
    {filename: modulePath}
  ).runInThisContext()(
    contextModule,
    function (requirePath) {
      const relativePoint = requirePath.startsWith('.')
        ? path.dirname(modulePath)
        : path.join(cwd(), 'node_modules');

      const absolutePathToModule = path.join(relativePoint, requirePath);

      return require(absolutePathToModule);
    },
    modulePath,
    path.dirname(modulePath)
  );

  return contextModule.exports && typeof contextModule.exports === 'object'
    ? ('default' in contextModule.exports
      ? contextModule.exports.default
      : contextModule.exports)
    : {};
}

requireModule.requireCompiledModule = requireCompiledModule;

module.exports = requireModule;