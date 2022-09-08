const fs = require('fs');
const path = require('path');
const {cwd} = require('process');
const {Script} = require('vm');

const {build, transform} = require('esbuild');

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

/**
 * Reaches the default value from the module's export.
 * It is needed because Babel and TypeScript have a convention
 * to put default exported value to the `exports.default` property.
 *
 * @template T
 * @param {T|{default: T}} module
 * @returns {T}
 */
const getDefaultExport = (module) => (
  module !== null && typeof module === 'object' && 'default' in module
    ? module.default
    : module
);

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

const ESBUILD_COMMON_BUILD_CONFIG = Object.freeze({
  write: false,
  format: 'cjs',
  loader: ESBUILD_LOADERS,
  bundle: true,
  target: 'node12',
  platform: 'node',
});

/**
 * Creates a VM instance for running in-memory code in the current global
 * context. It can run only CommonJS or IIFE code, because running
 * ES modules ability is still experimental (the current Node is 18).
 *
 * Some pseudo-global values are preserved in the context:
 *  1. `__filename`.
 *  2. `__dirname`.
 *  3. `require` (patched).
 *
 * See https://nodejs.org/api/modules.html#the-module-scope
 *
 * @template T
 * @param {string} realModulePath - an absolute path to the real module
 *  which content is loaded into memory.
 * @param {string} [virtualModulePath] - an absolute fake path to the in-memory
 *  code. It's useful for the VM in building error stack traces.
 * @returns {(code: string) => T} - the function which executes the _code_
 *  and returns the exported values.
 */
const createCodeRunnerFor = (realModulePath, virtualModulePath = realModulePath) =>
  (code) => {
    const contextModule = {
      exports: {}
    };

    new Script(`
      (function (module, require, __filename, __dirname) {
        var exports = module.exports;
        
        ${code}
      })
      `,
      { filename: virtualModulePath }
    ).runInThisContext()(
      contextModule,
      function (requirePath) {
        const relativePoint = requirePath.startsWith('.')
          ? path.dirname(realModulePath)
          : path.join(cwd(), 'node_modules');

        const absolutePathToModule = path.isAbsolute(requirePath)
          ? requirePath
          : path.join(relativePoint, requirePath);

        return require(absolutePathToModule);
      },
      realModulePath,
      path.dirname(realModulePath)
    );

    return getDefaultExport(contextModule.exports) ;
  }

/**
 * In opposite to the _requireModule_ this function does not load
 * module directly. Instead, it reads the source of the file and compile it
 * by using a loader based on the module extension.
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
    ...ESBUILD_COMMON_BUILD_CONFIG,
    entryPoints: [modulePath]
  });

  return createCodeRunnerFor(modulePath)(text);
}

/**
 * Function that has to be passed as the second argument to the "it"
 * test function. It can return some data that must be an object which
 * will be passed to the `test` function of the component if it exists.
 *
 * @callback TestBodyFunction
 * @param {Object} browser
 * @returns {void|object|Promise<void>|Promise<object>}
 */

/**
 * @callback TestCreator
 * @param {{ name: string, exportName: string, publicUrl: string }} data
 * @returns {TestBodyFunction}
 */

/**
 * @typedef {Object} TestDescription
 * @property {string|((exportName: string) => string)} name
 * @property {RegExp} filter
 * @property {(exports: Array<string>, modulePath: string) => Promise<Array<string>>} [exports]
 * @property {({ modulePath: string, publicUrl: string, exportName: string }) => TestBodyFunction} createTest
 */

const IDENTIFIER_RE = /\w\S*$/;
const GROUP_SEPARATOR_RE = /\s*,\s*/;
const DEFAULT_EXPORT_RE = /export\s+default/;
const INLINE_EXPORT_NAME_RE = /export\s+\w+\s+(\w\S*)/g;
const GROUP_EXPORT_NAMES_RE = /export\s+{\s*([^}]*)\s*}/g;

const MULTILINE_COMMENT_RE = /\/\*.*?\*\//gs;
const SINGLE_LINE_COMMENT_RE = /\/\/.*/g;

/**
 * Walks through the file's content and gathers all identifiers
 * that are exported. It detects a default export also.
 *
 * **Works with ES modules only for now.**
 *
 * @param {string} modulePath - an absolute module path.
 * @returns {Promise<Array<string>>}
 */
const findExportNamesIn = async (modulePath) => {
  const moduleContent = (await fs.promises.readFile(
    modulePath,
    { encoding: 'utf8' }
  ))
    .replace(MULTILINE_COMMENT_RE, '')
    .replace(SINGLE_LINE_COMMENT_RE, '');

  const names = new Set();

  if (DEFAULT_EXPORT_RE.test(moduleContent)) {
    names.add('default');
  }

  let result = null;

  while ((result = INLINE_EXPORT_NAME_RE.exec(moduleContent)) !== null) {
    result[1] && names.add(result[1]);
  }

  while ((result = GROUP_EXPORT_NAMES_RE.exec(moduleContent)) !== null) {
    if (result[1]) {
      result[1].split(GROUP_SEPARATOR_RE)
        .forEach((declaration) => {
        const [name] = IDENTIFIER_RE.exec(declaration);

        name && names.add(name);
      });
    }
  }

  return Array.from(names);
};

/**
 * Creates and executes a virtual test file instead of the one that
 * Nightwatch has found. A content for the test has to be provided by the user.
 *
 * **Test function has to be pure.**
 *
 * @template [T=object]
 * @param {string} modulePath
 * @param {TestDescription} description
 * @returns {T}
 */
const requireVirtualTest = async (modulePath, {
  name,
  exports,
  createTest,
}) => {
  const virtualFilePath = path.join(
    path.dirname(modulePath),
    path.basename(modulePath, path.extname(modulePath)) + '.js'
  );
  const modulePublicUrl = modulePath.replace(cwd(), '').split(path.sep).join('/');

  const allModuleExports = await findExportNamesIn(modulePath);

  const exportNames = exports
    ? await Promise.resolve(exports(allModuleExports, modulePath))
    : allModuleExports.filter((name) => name !== 'default');

  const { outputFiles: [{ text }] } = await build({
    ...ESBUILD_COMMON_BUILD_CONFIG,
    entryPoints: [modulePath]
  });

  const { code } = await transform(`
    ${text}
    
    describe("Virtual test for the ${path.basename(modulePath)} component", function () {
      ${exportNames.map((exportName) => `it(
        \`${typeof name === 'string' ? name : name(exportName)}\`,
        async function (browser) {
          const test = await Promise.resolve((${createTest.toString()})({
            modulePath: "${modulePath}",
            exportName: "${exportName}",
            publicUrl: "${modulePublicUrl}"
          }));
          
          const data = (await Promise.resolve(test(browser))) ?? {};
          
          await Promise.resolve(${
            exportName === 'default' 
              ? `${path.basename(modulePath, path.extname(modulePath))}_${exportName}`
              : exportName
          }.test?.(browser, data));
        }
      );`).join('\n')}
    });
  `, {
    sourcefile: virtualFilePath,
    format: ESBUILD_COMMON_BUILD_CONFIG.format,
    target: ESBUILD_COMMON_BUILD_CONFIG.target,
    loader: ESBUILD_LOADERS[path.extname(modulePath)],
    platform: ESBUILD_COMMON_BUILD_CONFIG.platform,
  });

  createCodeRunnerFor(modulePath, virtualFilePath)(code);

  // Nightwatch will try to search for a test instance in the returned
  // value, but virtual tests aren't designed for page object pattern.
  // Therefore, we don't have to return anything from this function.
  return {};
}

requireModule.getDefaultExport = getDefaultExport;
requireModule.requireVirtualTest = requireVirtualTest;
requireModule.requireCompiledModule = requireCompiledModule;

module.exports = requireModule;