'use strict';

var _ = require('underscore');
var present = require('present');
var util = require('../util');
var Histogram = require('../aggregation/histogram');
var MAP = require('../aggregation/map');

module.exports = function(env) {

  var Initialize = require('./initialize')(env);
  var kernels = require('./kernels')(env);

  function MCMC(s, k, a, wpplFn, options) {
    var options = util.mergeDefaults(options, {
      samples: 100,
      maxTime: Infinity,
      kernel: 'MH',
      lag: 0,
      burn: 0,
      callbacks: []
    });

    options.kernel = kernels.parseOptions(options.kernel);
    options.burnkernel = options.burnkernel ? kernels.parseOptions(options.burnkernel) : options.kernel;

    var callbacks = options.verbose ?
        [makeVMCallbackForPlatform()].concat(options.callbacks) :
        options.callbacks;
    _.invoke(callbacks, 'setup', numIters(options));

    var adRequired = options.kernel.adRequired || options.burnkernel.adRequired;

    var aggregator = (options.justSample || options.onlyMAP) ?
        new MAP(options.justSample, adRequired) :
        new Histogram();

    var initialize, run, finish;

    var initialTime;

    initialize = function() {
      initialTime = present();
      _.invoke(callbacks, 'initialize');
      return Initialize(run, wpplFn, s, env.exit, a, { ad: adRequired });
    };

    run = function(initialTrace) {
      initialTrace.info = { accepted: 0, total: 0 };
      var callback = kernels.tap(function(trace) { _.invoke(callbacks, 'iteration', trace); });
      var collectSample = makeExtractValue(aggregator.add.bind(aggregator));
      var kernel = kernels.sequence(options.kernel, callback);
      var burnkernel = kernels.sequence(options.burnkernel, callback);
      var chain = kernels.sequence(
          kernels.repeat(options.burn, burnkernel),
          kernels.repeat(options.samples,
              kernels.sequence(
                  kernels.repeat(options.lag + 1, kernel),
                  collectSample)));
      return chain(finish, initialTrace);
    };

    finish = function(trace) {
      _.invoke(callbacks, 'finish', trace);
      // console.log(trace.info.accepted / trace.info.total);
      return k(s, aggregator.toERP());
    };

    function makeExtractValue(fn) {
      return function(k, trace) {
        var time = present() - initialTime;
        fn(trace.value, trace.score, time);
        if (time > options.maxTime) {
          return finish(trace);
        } else {
          return k(trace);
        }
      };
    }

    return initialize();
  }

  function numIters(opts) {
    return opts.burn + (opts.lag + 1) * opts.samples;
  }

  // Callbacks.

  function makeVMCallback(opts) {
    var curIter = 0;
    return {
      iteration: function(trace) {
        opts.iteration(trace, curIter++);
      },
      finish: function(trace) {
        opts.finish(trace, curIter - 1);
      }
    };
  }

  function makeSimpleVMCallback() {
    return makeVMCallback({
      iteration: function(trace, i) {
        console.log(formatOutput(trace, i));
      },
      finish: _.identity
    });
  }

  // Node.js only.
  function makeOverwritingVMCallback() {
    var writeCurIter = function(trace, i) {
      process.stdout.write('\r' + formatOutput(trace, i));
    };
    return makeVMCallback({
      iteration: _.throttle(writeCurIter, 200, { trailing: false }),
      finish: function(trace, i) {
        writeCurIter(trace, i);
        console.log();
      }
    });
  }

  function formatOutput(trace, i) {
    var ratio = (trace.info.accepted / trace.info.total).toFixed(4);
    return 'Iteration: ' + i + ' | Acceptance ratio: ' + ratio;
  }

  function makeVMCallbackForPlatform() {
    return util.runningInBrowser() ? makeSimpleVMCallback() : makeOverwritingVMCallback();
  }

  return {
    MCMC: MCMC
  };

};
