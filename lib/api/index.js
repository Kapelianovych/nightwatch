const path = require('path');
const fs = require('fs');
const Utils = require('../utils');
const StaticApis = require('./_loaders/static.js');
const CommandLoader = require('./_loaders/command.js');
const ElementCommandLoader = require('./_loaders/element-command.js');
const AssertionLoader = require('./_loaders/assertion.js');
const ExpectLoader = require('./_loaders/expect.js');
const PageObjectLoader = require('./_loaders/page-object.js');
const PluginLoader = require('./_loaders/plugin.js');

const __elementCommands = [];

class ApiLoader {
  static isElementCommand(commandName) {
    return __elementCommands.includes(commandName);
  }

  static get CommandFiles() {
    return {
      protocolActions: {
        dirPath: 'protocol',
        protocol: true
      },
      clientCommands: 'client-commands',

      elementCommands: {
        dirPath: 'element-commands',
        element: true,
        loader: ElementCommandLoader
      },

      assertions: {
        loader: AssertionLoader,
        dirPath: 'assertions',
        element: true,
        namespaces: {
          assert: {
            abortOnFailure: true
          },
          verify: {
            abortOnFailure: false
          }
        }
      },

      expect: {
        loader: ExpectLoader,
        dirPath: 'expect',
        element: true,
        namespaces: {
          expect: {
            abortOnFailure: true
          },
          should: {
            abortOnFailure: false
          }
        }
      }
    };
  }

  /**
   * @param {*} customPath
   * @return {Array}
   */
  static adaptCustomPath(customPath) {
    return customPath.map(location => {
      return path.resolve(location);
    });
  }

  static init(nightwatchInstance) {
    const api = new ApiLoader(nightwatchInstance);
    const staticApis = new StaticApis(nightwatchInstance);
    staticApis.loadStaticAssertions();
    staticApis.loadStaticExpect();

    api.loadApiCommandsSync();
    api.loadCustomCommandsSync();
    api.loadCustomAssertionsSync();
    api.loadPlugins();
    api.loadPageObjectsSync();
    api.loadVirtuals();

    if (!nightwatchInstance.unitTestingMode) {
      const EnsureApi = require('./_loaders/ensure.js');
      const ensureApi = new EnsureApi(nightwatchInstance);
      ensureApi.loadAssertions();

      const ChromeApi = require('./_loaders/chrome.js');
      const chromeApis = new ChromeApi(nightwatchInstance);
      chromeApis.loadCommands();

      const FirefoxApi = require('./_loaders/firefox.js');
      const firefoxApis = new FirefoxApi(nightwatchInstance);
      firefoxApis.loadCommands();
    }
  }

  constructor(nightwatchInstance) {
    this.nightwatchInstance = nightwatchInstance;
  }

  get api() {
    return this.nightwatchInstance.api;
  }

  get reporter() {
    return this.nightwatchInstance.reporter;
  }

  get settings() {
    return this.nightwatchInstance.settings;
  }

  get commandQueue() {
    return this.nightwatchInstance.queue;
  }

  static makeAssertProxy(api) {
    return new Proxy(api, {
      get(target, name) {
        if (name === 'not') {
          return new Proxy(api, {
            get(target, name) {
              return function (...args) {
                if (!Utils.isFunction(target[name])) {
                  throw new Error(`Unknown api method .not."${name}".`);
                }

                return target[name]({negate: true, args});
              };
            }
          });
        }

        return function (...args) {
          if (typeof name != 'string') {
            return null;
          }
          if (!Utils.isFunction(target[name])) {
            throw new Error(`Unknown api method "${name}".`);
          }

          return target[name]({negate: false, args});
        };
      }
    });
  }


  loadPlugins(parent = null) {
    const plugins = this.nightwatchInstance.options.plugins || [];

    plugins.forEach(pluginName => {
      const plugin = PluginLoader.load(pluginName);

      if (plugin.commands) {
        this.__loadCustomObjectsSync({
          parent,
          sourcePath: plugin.commands,
          isUserDefined: true
        });
      }

      if (plugin.assertions) {
        this.__loadCustomObjectsSync({
          parent,
          sourcePath: plugin.assertions,
          namespaces: ApiLoader.CommandFiles.assertions.namespaces,
          Loader: AssertionLoader
        });
      }

      if (plugin.virtuals) {
        this.nightwatchInstance.virtuals.push(...plugin.virtuals);
      }
    });
  }

  /** Loads settings for the virtual test suites. */
  loadVirtuals() {
    const pathToVirtuals = path.resolve(
      this.nightwatchInstance.options.virtuals_path || path.join('nightwatch', 'virtuals.js')
    );

    this.nightwatchInstance.virtuals = fs.existsSync(pathToVirtuals)
      ? Utils.getDefaultExport(require(pathToVirtuals))
      : [];
  }

  /**
   * Loads the page objects, if defined
   * @param parent
   */
  loadPageObjectsSync(parent = null) {
    this.__loadCustomObjectsSync({
      parent,
      sourcePath: this.nightwatchInstance.options.page_objects_path,
      isUserDefined: true,
      Loader: PageObjectLoader
    });
  }

  /**
   * Loads custom assertions, if defined
   *
   * @param parent
   */
  loadCustomAssertionsSync(parent = null) {
    this.__loadCustomObjectsSync({
      parent,
      sourcePath: this.nightwatchInstance.options.custom_assertions_path,
      namespaces: ApiLoader.CommandFiles.assertions.namespaces,
      Loader: AssertionLoader
    });
  }

  /**
   * Loads custom commands, if defined
   * @param parent
   */
  loadCustomCommandsSync(parent = null) {
    this.__loadCustomObjectsSync({
      parent,
      sourcePath: this.nightwatchInstance.options.custom_commands_path,
      isUserDefined: true
    });
  }

  /**
   * Loads built-in api commands, assertions, and expect definitions
   * @param parent
   */
  loadApiCommandsSync(parent = null) {
    Object.keys(ApiLoader.CommandFiles)
      .forEach((key) => {
        const commands = ApiLoader.CommandFiles[key];
        const {namespaces} = commands;

        let dirPath;
        let Loader = CommandLoader;
        let isProtocolCommand = false;
        let isElementCommand = false;

        if (Utils.isString(commands)) {
          dirPath = path.join(__dirname, commands);
        } else {
          dirPath = path.join(__dirname, commands.dirPath);
          isProtocolCommand = commands.protocol;
          isElementCommand = commands.element;

          if (commands.loader) {
            Loader = commands.loader;
          }
        }

        const opts = {
          dirPath,
          parent,
          Loader,
          isProtocolCommand,
          isElementCommand,
          namespacesObj: namespaces
        };

        // protocol commands are not loaded onto the main page object
        if (parent && isProtocolCommand) {
          return;
        }

        this.__loadCommandsSync(opts);
      });
  }

  addCommandDefinitionSync({
    dirPath,
    isUserDefined = false,
    fileName,
    parent,
    namespace = [],
    abortOnFailure = false,
    isProtocolCommand = false,
    isElementCommand = false,
    Loader = CommandLoader
  }) {
    const loader = new Loader(this.nightwatchInstance);
    loader.isUserDefined = isUserDefined;

    if (namespace && namespace.length) {
      loader.setNamespace(namespace);
    }

    loader
      .loadModule(dirPath, fileName)
      .createWrapper(abortOnFailure)
      .define(parent);

    if (isElementCommand && loader.commandName && !__elementCommands.includes(loader.commandName)) {
      __elementCommands.push(loader.commandName);
    }
  }

  __loadCustomObjectsSync({parent = null, Loader = CommandLoader, namespaces, sourcePath}) {
    if (!sourcePath) {
      sourcePath = [];
    }

    if (!Array.isArray(sourcePath)) {
      sourcePath = [sourcePath];
    }

    const dirPathArr = ApiLoader.adaptCustomPath(sourcePath);
    const commandFiles = [];

    dirPathArr.forEach((dirPath, index) => this.__loadCommandsSync({
      parent,
      dirPath,
      originalSourcePath: sourcePath[index],
      isUserDefined: true,
      namespacesObj: namespaces,
      Loader,
      loadAction(opts) {
        commandFiles.push(opts);
      }
    }));

    const hasCorrespondingJsFile = (parsedResource) => {
      const jsFile = path.join(parsedResource.dir, `${parsedResource.name}${Utils.jsFileExt}`);

      const entry = commandFiles.find(({dirPath, fileName}) => {
        return path.join(dirPath, fileName) === jsFile;
      });

      return !!entry;
    };

    const commandFilesProcessed = commandFiles.reduce((prev, opts) => {
      const {dirPath, fileName} = opts;
      const fullPath = path.join(dirPath, fileName);
      const parsedResource = path.parse(fullPath);
      const isTypeScriptFile = parsedResource.ext === Utils.tsFileExt;

      // ignore `.ts` files if a `.js` has already been loaded
      if (isTypeScriptFile && hasCorrespondingJsFile(parsedResource)) {
        return prev;
      }

      prev.push(opts);

      return prev;
    }, []);

    commandFilesProcessed.forEach(opts => this.addCommandDefinitionSync(opts));
  }

  __loadCommandsSync({
    parent = null,
    namespacesObj = null,
    ns = null,
    dirPath,
    originalSourcePath,
    abortOnFailure = false,
    isProtocolCommand = false,
    isElementCommand = false,
    isUserDefined = false,
    Loader = CommandLoader,
    loadAction = this.addCommandDefinitionSync.bind(this)
  }) {
    if (namespacesObj) {
      Object.keys(namespacesObj).forEach((ns) => this.__loadCommandsSync({
        ns,
        parent,
        dirPath,
        isUserDefined,
        isElementCommand,
        Loader,
        abortOnFailure: namespacesObj[ns].abortOnFailure
      }));
    } else {
      Utils.readFolderRecursively(dirPath, [], (dirPath, fileName, namespace) => {
        loadAction.call(this, {
          dirPath,
          fileName,
          parent,
          isUserDefined,
          namespace: ns || namespace,
          isProtocolCommand,
          isElementCommand,
          Loader,
          abortOnFailure
        });
      }, function readDirFn(sourcePath) {
        try {
          return {
            resources: fs.readdirSync(sourcePath),
            sourcePath
          };
        } catch (err) {
          if (err.code === 'ENOENT' && originalSourcePath && originalSourcePath.startsWith('examples/')) {
            return readDirFn(path.join('node_modules/nightwatch/', originalSourcePath));
          }

          throw err;
        }

      });
    }
  }
}

module.exports = ApiLoader;
