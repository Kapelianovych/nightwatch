const path = require('path');
const Convert = require('ansi-to-html');

const Concurrency = require('../runner/concurrency');
const DefaultSettings = require('../settings/defaults.js');
const Utils = require('../utils');
const Results = require('./results.js');
const Summary = require('./summary.js');
const {Logger, beautifyStackTrace} = Utils;
const colors = Logger.colors;

module.exports = class GlobalReporter {
  static get initialReport() {
    return {
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
      tests: 0,
      assertions: 0,
      errmessages: [],
      modules: {}
    };
  }

  constructor(reporter = DefaultSettings.default_reporter, settings, openReport = false) {
    this.suiteResults = [];
    this.skippedSuites = 0;
    this.uncaughtErr = null;
    this.reporterFile = reporter;

    if (!Array.isArray(this.reporterFile)) {
      this.reporterFile = [reporter];
    }
    this.settings = settings;
    this.summary = new Summary(settings);
    this.openReport = openReport;
    this.ansiConverter = new Convert();
  }

  registerUncaughtErr(err) {
    this.uncaughtErr = err;
  }

  isDisabled() {
    return this.settings.output_folder === false;
  }

  hasTestFailures() {
    return this.uncaughtErr || this.suiteResults.some(item => {
      return item.hasFailures;
    });
  }

  addTestSuiteResults(testResults) {
    testResults = testResults || {};
    testResults.httpOutput = Logger.collectOutput().map(item => {
      return [item[0], this.ansiConverter.toHtml(item[1]),
        (item[2] ? this.ansiConverter.toHtml(item[2]) : '')];
    });

    this.suiteResults.push(testResults);

    return this;
  }

  setupChildProcessListener(emitter) {
    if (!Concurrency.isTestWorker()) {
      emitter.on('message', data => {
        data = JSON.parse(data);
        this.addTestSuiteResults(data.results);
      });
    }
  }

  create(startTime) {
    const initialReport = GlobalReporter.initialReport;

    if (this.uncaughtErr) {
      initialReport.errors++;
      const errorMessage = Logger.getErrorContent(this.uncaughtErr);
      initialReport.errmessages.push(errorMessage);
    }

    this.elapsedTime = new Date().getTime() - startTime;
    this.globalResults = Results.createGlobalReport(this.suiteResults, initialReport);

    return this;
  }

  print() {
    if (Concurrency.isChildProcess() || !this.settings.output) {
      return this;
    }

    if (this.hasTestFailures()) {
      const countMessage = this.getTestsFailedMessage();

      const {columns = 100} = process.stdout;
      // eslint-disable-next-line no-console
      console.log(colors.light_red('\n' + new Array(Math.max(100, columns - 20)).join('─')));

      // eslint-disable-next-line no-console
      console.log(`\n  ${colors.light_red('TEST FAILURE')} ${colors.stack_trace('(' + Utils.formatElapsedTime(this.elapsedTime) + ')')}${colors.light_red(':')} ${countMessage}\n`);

      this.summary.print(this.globalResults);
      // eslint-disable-next-line no-console
      console.log('');
    } else {
      if (!this.shouldShowSummary()) {
        return;
      }

      const message = this.getTestsPassedMessage();
      // eslint-disable-next-line no-console
      console.log(`\n${message} ${colors.stack_trace('(' + Utils.formatElapsedTime(this.elapsedTime) + ')')}`);
    }

    return this;
  }

  loadReporter() {
    const allAvailableReporters = this.reporterFile.slice(0);

    return Promise.all(allAvailableReporters.map((reporter) => this.loadFile(reporter)));
  }

  async loadFile(reporterFile) {
    const builtInReporterFileName = path.join(__dirname, 'reporters', reporterFile + '.js');
    const fileExists = await Utils.fileExists(builtInReporterFileName);

    if (!fileExists) {
      return this.loadCustomReporter(reporterFile);
    }

    return require(builtInReporterFileName);
  }

  async loadCustomReporter(reporterFile) {
    let customReporterModuleExists;
    let reporter;

    try {
      reporter = require(reporterFile);
      customReporterModuleExists = true;
    } catch (err) {
      customReporterModuleExists = false;
    }

    const customReporterExists = await Utils.fileExists(reporterFile);

    if (!customReporterExists && !customReporterModuleExists) {
      throw new Error(`The custom reporter "${reporterFile}" cannot be resolved.`);
    }

    if (!customReporterModuleExists) {
      reporter = require(path.resolve(reporterFile));
    }

    if (Utils.isFunction(reporter.write)) {
      return reporter;
    }

    throw new Error(`The custom reporter "${reporterFile}" must have a public ".write(results, options, [callback])" method defined which should return a Promise.`);
  }

  async writeReportToFile(globalResults) {
    if (this.isDisabled()) {
      return;
    }

    try {
      await Utils.createFolder(this.settings.output_folder);
      const reporters = await this.loadReporter();

      return Promise.all(
        reporters.map(reporterFile => this.writeReport(reporterFile, globalResults))
      );
    } catch (err) {
      const error = new Error('An error occurred while trying to save the report file');
      error.detailedErr = err.message;

      throw error;
    }
  }

  async writeReport(reporter, globalResults) {
    const {globals, output_folder, start_session, folder_format} = this.settings;
    const needsCallback = reporter.write.length === 3;
    const options = {
      filename_prefix: this.settings.report_prefix,
      output_folder,
      globals,
      start_session,
      reporter,
      openReport: this.openReport,
      folder_format
    };

    if (needsCallback) {
      // backwards compatibility
      return new Promise((resolve, reject) => {
        reporter.write(globalResults, options, function (err) {
          if (err) {
            return reject(err);
          }
          resolve();
        });
      });
    }

    return await reporter.write(globalResults, options);
  }

  shouldShowSummary() {
    const modules = Object.keys(this.globalResults.modules);
    if (modules.length > 1) {
      return true;
    }

    if (modules.length <= 0) {
      return false;
    }

    return Object.keys(this.globalResults.modules[modules[0]].completed).length > 1;
  }

  hasAssertionCount() {
    const testsCounts = this.getTotalTestsCount();

    return !this.settings.unit_tests_mode && testsCounts > 0 && this.globalResults.assertions > 0;
  }

  getTotalTestsCount() {
    return Object.keys(this.globalResults.modules)
      .reduce((count, moduleKey) => {
        const module = this.globalResults.modules[moduleKey];

        return count + module.tests;
      }, 0);
  }

  getTestsFailedMessage() {
    const hasCount = this.hasAssertionCount();
    const totalTests = this.getTotalTestsCount();

    let errorsMsg = '';
    const failedMsg = hasCount ? 'assertions' : 'tests';
    let passedMsg = colors.green(this.globalResults.passed) + ' passed'; // assertions passed

    const skippedSuitesCount = this.skippedSuites > 0 ? `\n   - ${colors.light_red(this.skippedSuites)} other test suites were aborted; ` : '';

    if (!hasCount) {
      const passedCount = Math.max(0, totalTests - this.globalResults.failed - this.globalResults.errors); // testcases passed
      passedMsg = '\n   - '+ colors.green(passedCount + '/' + (totalTests > 0 ? totalTests : 'NA')) + ' tests passed';
    }

    let skipped = '';
    if (this.globalResults.skipped) {
      skipped = `\n   - ${colors.cyan(this.globalResults.skipped)} skipped`;
    }

    const globalErrors = this.globalResults.errors;
    if (globalErrors) {
      const suffix = globalErrors > 1 ? 's' : '';
      errorsMsg += `\n   - ${colors.red(globalErrors)} error${suffix} during execution;`;
    }

    const failedCountMsg = `\n   - ${colors.red(this.globalResults.failed)} ${failedMsg} failed;`;

    return `${errorsMsg} ${skippedSuitesCount}${failedCountMsg} ${passedMsg}${skipped}`;
  }

  getTestsPassedMessage() {
    const hasCount = this.hasAssertionCount();
    let message;
    let count;

    if (hasCount) {
      count = this.globalResults.passed;
      message = colors.green(`OK. ${count} ${count > 1 ? ' total assertions' : ' assertion'} passed`);
    } else {
      count = this.getTotalTestsCount();
      message = `${colors.green('OK. ' + count)} tests passed`;
    }

    return message;
  }

  runCustomGlobalReporter(globalResults) {
    const customReporter = this.settings.globals.reporter;

    return new Promise((resolve, reject) => {
      const callbackTimeoutId = setTimeout(() => {
        reject(new Error('Timeout while waiting (20s) for the custom global reporter callback to be called.'));
      }, this.settings.globals.customReporterCallbackTimeout);

      try {
        const reporterFnAsync = Utils.makeFnAsync(2, customReporter, this.settings.globals);
        reporterFnAsync.call(this.settings.globals, globalResults, function() {
          clearTimeout(callbackTimeoutId);
          resolve();
        });
      } catch (err) {
        clearTimeout(callbackTimeoutId);
        reject(err);
      }
    });
  }

  save() {
    return Promise.all([
      this.runCustomGlobalReporter(this.globalResults),
      this.writeReportToFile(this.globalResults)
    ]);
  }
};
