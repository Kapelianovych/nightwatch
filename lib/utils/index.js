const path = require('path');
const fs = require('fs');
const mkpath = require('mkpath');
const glob = require('glob');
const lodashMerge = require('lodash.merge');
const {By} = require('selenium-webdriver');

const Logger = require('./logger');
const BrowserName = require('./browsername.js');
const LocateStrategy = require('./locatestrategy.js');
const PeriodicPromise = require('./periodic-promise.js');
const createPromise = require('./createPromise.js');
const isErrorObject = require('./isErrorObject.js');
const alwaysDisplayError = require('./alwaysDisplayError.js');
const Screenshots = require('./screenshots.js');
const TimedCallback = require('./timed-callback.js');
const getFreePort = require('./getFreePort.js');
const requireModule = require('./requireModule.js');
const getAllClassMethodNames = require('./getAllClassMethodNames.js');
const printVersionInfo = require('./printVersionInfo.js');
const {filterStack, filterStackTrace, showStackTrace, stackTraceFilter, errorToStackTrace} = require('./stackTrace.js');
const beautifyStackTrace = require('./beautifyStackTrace.js');
const SafeJSON = require('./safeStringify.js');
const formatRegExp = /%[sdj%]/g;
const testSuiteNameRegxp = /(_|-|\.)*([A-Z]*)/g;
const nameSeparatorRegxp = /(\s|\/)/;

const PrimitiveTypes = {
  OBJECT: 'object',
  FUNCTION: 'function',
  BOOLEAN: 'boolean',
  NUMBER: 'number',
  STRING: 'string',
  UNDEFINED: 'undefined'
};

class Utils {
  static get tsFileExt() {
    return '.ts';
  }

  static get jsFileExt() {
    return '.js';
  }

  static isObject(obj) {
    return obj !== null && typeof obj == 'object';
  }

  static isFunction(fn) {
    return typeof fn == PrimitiveTypes.FUNCTION;
  }

  static isBoolean(value) {
    return typeof value == PrimitiveTypes.BOOLEAN;
  }

  static isNumber(value) {
    return typeof value == PrimitiveTypes.NUMBER;
  }

  static isString(value) {
    return typeof value == PrimitiveTypes.STRING;
  }

  static isUndefined(value) {
    return typeof value == PrimitiveTypes.UNDEFINED;
  }

  static isDefined(value) {
    return !Utils.isUndefined(value);
  }

  static isES6AsyncFn(fn) {
    return Utils.isFunction(fn) && fn.constructor.name === 'AsyncFunction';
  }

  static enforceType(value, type) {
    type = type.toLowerCase();

    switch (type) {
      case PrimitiveTypes.STRING:
      case PrimitiveTypes.BOOLEAN:
      case PrimitiveTypes.NUMBER:
      case PrimitiveTypes.FUNCTION:
        if (typeof value != type) {
          throw new Error(`Invalid type ${typeof value} for value "${value}". Expecting "${type}" instead.`);
        }

        return;
    }

    throw new Error(`Invalid type ${type} for ${value}`);
  }

  static convertBoolean(value) {
    if (Utils.isString(value) && (!value || value === 'false' || value === '0')) {
      return false;
    }

    return Boolean(value);
  }

  static get symbols() {
    let ok = String.fromCharCode(10004);
    let fail = String.fromCharCode(10006);

    if (process.platform === 'win32') {
      ok = '\u221A';
      fail = '\u00D7';
    }

    return {
      ok: ok,
      fail: fail
    };
  }

  /**
   * @param {object|string} definition
   * @return {object}
   */
  static convertToElementSelector(definition) {
    const selector = Utils.isString(definition) ? {selector: definition} : definition;

    return selector;
  }

  static isElementGlobal(selector) {
    return selector.webElementLocator instanceof By;
  }

  /**
   * @param {object} definition
   * @param {object} [props]
   * @return {object}
   */
  static setElementSelectorProps(definition, props = {}) {
    const selector = Utils.convertToElementSelector(definition);
    if (!selector || Utils.isElementGlobal(selector)) {
      return selector;
    }

    Object.keys(props).forEach(function(key) {
      selector[key] = props[key];
    });

    return selector;
  }

  static formatElapsedTime(timeMs, includeMs = false) {
    const seconds = timeMs/1000;

    return (seconds < 1 && timeMs + 'ms') ||
      (seconds > 1 && seconds < 60 && (seconds + 's')) ||
      (Math.floor(seconds/60) + 'm' + ' ' + Math.floor(seconds%60) + 's' + (includeMs ? (' / ' + timeMs + 'ms') : ''));
  }

  /**
   * Wrap a synchronous function, turning it into an psuedo-async fn with a callback as
   * the last argument if necessary. `asyncArgCount` is the expected argument
   * count if `fn` is already asynchronous.
   *
   * @deprecated
   * @param {number} asyncArgCount
   * @param {function} fn
   * @param {object} [context]
   */
  static makeFnAsync(asyncArgCount, fn, context) {
    if (fn.length === asyncArgCount) {
      return fn;
    }

    return function(...args) {
      const done = args.pop();
      context = context || null;
      fn.apply(context, args);
      done();
    };
  }

  static makePromise(handler, context, args) {
    const result = Reflect.apply(handler, context, args);
    if (result instanceof Promise) {
      return result;
    }

    return Promise.resolve(result);
  }

  static checkFunction(name, parent) {
    return parent && (typeof parent[name] == 'function') && parent[name] || false;
  }

  static getTestSuiteName(moduleName) {
    let words;

    moduleName = moduleName.replace(testSuiteNameRegxp, function(match, $0, $1, offset, string) {
      if (!match) {
        return '';
      }

      return (offset > 0 && (string.charAt(offset-1) !== ' ') ? ' ':'') + $1;
    });

    words = moduleName.split(nameSeparatorRegxp).map(function(word, index, matches) {
      if (word === '/') {
        return '/';
      }

      return word.charAt(0).toUpperCase() + word.substr(1);
    });

    return words.join('');
  }

  /**
   * A smaller version of util.format that doesn't support json and
   * if a placeholder is missing, it is omitted instead of appended
   *
   * @param f
   * @returns {string}
   */
  static format(message, selector, timeMS) {
    return String(message).replace(formatRegExp, function(exp) {
      if (exp === '%%') {
        return '%';
      }

      switch (exp) {
        case '%s':
          return String(selector);

        case '%d':
          return Number(timeMS);

        default:
          return exp;
      }
    });
  }

  static getModuleKey(filePath, srcFolders, fullPaths) {
    const modulePathParts = filePath.split(path.sep);
    let diffInFolder = '';
    let folder = '';
    let parentFolder = '';
    const moduleName = modulePathParts.pop();
    filePath = modulePathParts.join(path.sep);

    if (srcFolders) {
      for (let i = 0; i < srcFolders.length; i++) {
        folder = path.resolve(srcFolders[i]);
        if (fullPaths.length > 1) {
          parentFolder = folder.split(path.sep).pop();
        }
        if (filePath.indexOf(folder) === 0) {
          diffInFolder = filePath.substring(folder.length + 1);
          break;
        }
      }
    }

    return path.join(parentFolder, diffInFolder, moduleName);
  }

  static getOriginalStackTrace(commandFn) {
    let originalStackTrace;

    if (commandFn.stackTrace) {
      originalStackTrace = commandFn.stackTrace;
    } else {
      const err = new Error;
      Error.captureStackTrace(err, commandFn);
      originalStackTrace = err.stack;
    }

    return originalStackTrace;
  }

  // util to replace deprecated fs.existsSync
  static dirExistsSync(path) {
    try {
      return fs.statSync(path).isDirectory(); // eslint-disable-next-line no-empty
    } catch (e) {}

    return false;
  }

  static fileExistsSync(path) {
    try {
      return fs.statSync(path).isFile(); // eslint-disable-next-line no-empty
    } catch (e) {}

    return false;
  }

  static fileExists(path) {
    return Utils.checkPath(path)
      .then(function(stats) {
        return stats.isFile();
      })
      .catch(function(err) {
        return false;
      });
  }

  static isTsFile(fileName) {
    const extension = path.extname(fileName);

    return extension === Utils.tsFileExt ||
      extension === '.mts' ||
      extension === '.cts' ||
      extension === '.tsx';
  }

  static isFileNameValid(fileName) {
    return [
      Utils.jsFileExt,
      '.mjs',
      '.cjs',
      '.jsx',
      Utils.tsFileExt,
      // New file extensions came in TS 4.7
      // https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-7.html#new-file-extensions
      '.mts',
      '.cts',
      '.tsx'
    ].includes(path.extname(fileName));
  }

  static checkPath(source, originalErr = null, followSymlinks = true) {
    return new Promise(function(resolve, reject) {
      if (glob.hasMagic(source)) {
        return resolve();
      }
      
      fs[followSymlinks ? 'stat' : 'lstat'](source, function(err, stats) {
        if (err) {
          return reject(err.code === 'ENOENT' && originalErr || err);
        }

        resolve(stats);
      });
    });
  }

  /**
   * @param {string} source
   * @return {Promise}
   */
  static isFolder(source) {
    return Utils.checkPath(source, null, false).then(stats => stats.isDirectory());
  }

  /**
   * @param {string} source
   * @return {Promise}
   */
  static readDir(source) {
    return new Promise(function(resolve, reject) {
      const callback = function(err, list) {
        if (err) {
          return reject(err);
        }
        resolve(list);
      };
      
      glob.hasMagic(source) ? glob(source, callback) : fs.readdir(source, callback);
    });
  }

  /**
   *
   * @param {string} sourcePath
   * @param {Array} namespace
   * @param {function} loadFn
   * @param {function} readSyncFn
   */
  static readFolderRecursively(sourcePath, namespace = [], loadFn, readSyncFn) {
    let resources;
    if (glob.hasMagic(sourcePath)) {
      resources = glob.sync(sourcePath);
    } else if (Utils.isFunction(readSyncFn)) {
      const result = readSyncFn(sourcePath);
      sourcePath = result.sourcePath;
      resources = result.resources;
    } else {
      resources = fs.readdirSync(sourcePath);
    }

    resources.sort(); // makes the list predictable
    resources.forEach(resource => {
      if (path.isAbsolute(resource)) {
        sourcePath = path.dirname(resource);
        resource = path.basename(resource);
      }

      const isFolder = fs.lstatSync(path.join(sourcePath, resource)).isDirectory();
      if (isFolder) {
        const pathFolder = path.join(sourcePath, resource);
        const ns = namespace.slice(0);
        ns.push(resource);
        Utils.readFolderRecursively(pathFolder, ns, loadFn);

        return;
      }

      loadFn(sourcePath, resource, namespace);
    });
  }

  static getPluginPath(pluginName) {
    return path.resolve(require.resolve(pluginName, {
      paths: [process.cwd()]
    }));
  }

  static singleSourceFile(argv = {}) {
    const {test, _source} = argv;

    if (Utils.isString(test)) {
      return Utils.fileExistsSync(test);
    }

    return Array.isArray(_source) && _source.length === 1 && Utils.fileExistsSync(_source[0]);
  }

  static getConfigFolder(argv) {
    if (!argv || !argv.config) {
      return '';
    }

    return path.dirname(argv.config);
  }

  /**
   *
   * @param {Array} arr
   * @param {number} maxDepth
   * @param {Boolean} includeEmpty
   * @returns {Array}
   */
  static flattenArrayDeep(arr, maxDepth = 4, includeEmpty = false) {
    if (!Array.isArray(arr)) {
      throw new Error(`Utils.flattenArrayDeep excepts an array to be passed. Received: "${arr === null ? arr : typeof arr}".`);
    }

    return (function flatten(currentArray, currentDepth, initialValue = []) {
      currentDepth = currentDepth + 1;

      return currentArray.reduce(function(prev, value) {
        if (Array.isArray(value)) {
          const result = prev.concat(value);
          if (Array.isArray(result) && currentDepth <= maxDepth) {
            return flatten(result, currentDepth);
          }

          return result;
        }

        currentDepth = 0;

        if (!includeEmpty && (value === null || value === undefined || value === '')) {
          return prev;
        }

        prev.push(value);

        return prev;
      }, initialValue);
    })(arr, 0);
  }

  /**
   * Strips out all control characters from a string
   * However, excludes newline and carriage return
   *
   * @param {string} input String to remove invisible chars from
   * @returns {string} Initial input string but without invisible chars
   */
  static stripControlChars(input) {
    return input && input.replace(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g,
      ''
    );
  }

  static relativeUrl(url) {
    return !(url.includes('://'));
  }

  static uriJoin(baseUrl, uriPath) {
    let result = baseUrl;

    if (baseUrl.endsWith('/')) {
      result = result.substring(0, result.length - 1);
    }

    if (!uriPath.startsWith('/')) {
      result = result + '/';
    }

    return result + uriPath;
  }

  static replaceParams(url, params = {}) {
    return Object.keys(params).reduce(function(prev, param) {
      prev = prev.replace(`:${param}`, params[param]);

      return prev;
    }, url);
  }

  static createFolder(dirPath) {
    return new Promise((resolve, reject) => {
      mkpath(dirPath, function(err) {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  static containsMultiple(arrayOrString, valueToFind, separator = ',') {
    if (typeof valueToFind == 'string') {
      valueToFind = valueToFind.split(separator);
    }

    if (Array.isArray(valueToFind)) {
      if (valueToFind.length > 1) {
        return valueToFind.every(item => arrayOrString.includes(item));
      }

      valueToFind = valueToFind[0];
    }

    return arrayOrString.includes(valueToFind);
  }

  static shouldReplaceStack(err) {
    return !alwaysDisplayError(err);
  }
}

lodashMerge(Utils, {
  PrimitiveTypes,
  BrowserName,
  LocateStrategy,
  Logger,
  isErrorObject,
  requireModule,
  getDefaultExport: requireModule.getDefaultExport,
  requireVirtualTest: requireModule.requireVirtualTest,
  requireCompiledModule: requireModule.requireCompiledModule,
  createPromise,
  getAllClassMethodNames,
  SafeJSON,

  filterStack,
  filterStackTrace,
  showStackTrace,
  stackTraceFilter,
  errorToStackTrace,

  PeriodicPromise,
  Screenshots,
  TimedCallback,

  getFreePort,
  printVersionInfo,

  alwaysDisplayError,
  beautifyStackTrace
});

module.exports = Utils;
