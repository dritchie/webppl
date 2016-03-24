'use strict';

var assert = require('assert');
var _ = require('underscore');
var util = require('../../util');

module.exports = function(env) {

  var kernels = {};

  // Register a kernel function with a given name
  function registerKernel(name, kernelfn) {
    assert(!_.has(kernels, name), 'kernel named ' + name + ' has already been registered.');
    kernels[name] = kernelfn;
  };

  // Takes an options object (as passed to inference algorithms) and
  // converts kernel options into functions with options partially
  // applied. For example:

  // 'MH' => function(..., opts) { return MHKernel(..., opts); }
  // { MH: options } => function(..., extraOpts) { return MHKernel(..., merge(options, extraOpts)) }

  function parseOptions(obj) {
    // Expects either a kernel name or an object containing a single
    // key/value pair where the key is a kernel name and the value is
    // an options object. e.g. 'MH' or { MH: { ... } }

    function isKernelOption(obj) {
      return _.isString(obj) && _.has(kernels, obj) ||
          _.size(obj) === 1 && _.has(kernels, _.keys(obj)[0]);
    }

    if (!isKernelOption(obj)) {
      throw 'Unrecognized kernel option: ' + JSON.stringify(obj);
    }

    var name = _.isString(obj) ? obj : _.keys(obj)[0];
    var options = _.isString(obj) ? {} : _.values(obj)[0];
    var kernel = kernels[name];

    return _.extendOwn(function(cont, oldTrace, extraOptions) {
      var allOptions = _.extendOwn({}, options, extraOptions);
      return kernel(cont, oldTrace, allOptions);
    }, kernel);
  }

  // Combinators for kernel functions.

  function tap(fn) {
    return function(k, trace) {
      fn(trace);
      return k(trace);
    };
  }

  function sequence() {
    var kernels = arguments;
    assert(kernels.length > 1);
    if (kernels.length === 2) {
      return function(k, trace1) {
        return kernels[0](function(trace2) {
          return kernels[1](k, trace2);
        }, trace1);
      };
    } else {
      return sequence(
          kernels[0],
          sequence.apply(null, _.rest(kernels)));
    }
  }

  function repeat(n, kernel) {
    return function(k, trace) {
      return util.cpsIterate(n, trace, kernel, k);
    };
  }


  // --------------------------------------------------------------------------


  var MHKernel = require('./mhkernel')(env);
  var HMCKernel = require('./hmckernel')(env);
  var LARJKernel = require('./larjkernel')(env);

  // -------

  function HMCwithMHKernel(cont, oldTrace, options) {
    // The options arg is passed to both kernels as SMC passes
    // exitFactor via options.
    var opts = _.extendOwn({ discreteOnly: true, adRequired: true }, options);
    return HMCKernel(function(trace) {
      return MHKernel(cont, trace, opts);
    }, oldTrace, options);
  }
  HMCwithMHKernel.adRequired = true;

  // -------

  // LARJ_MH
  function MHcontinuous(cont, oldTrace, options) {
    var opts = _.extendOwn({ continuousOnly: true }, options);
    return MHKernel(cont, oldTrace, opts);
  }
  function MHdiscrete(cont, oldTrace, options) {
    var opts = _.extendOwn({ discreteOnly: true }, options);
    return MHKernel(cont, oldTrace, opts);
  }
  function LARJ_MH_Kernel(cont, oldTrace, options) {
    var opts = _.extendOwn({
      jumpKernel: MHdiscrete,
      diffusionKernel: MHcontinuous
    }, options);
    return LARJKernel(cont, oldTrace, opts);
  }

  // LARJ_HMC
  function MHdiscreteAD(cont, oldTrace, options) {
    var opts = _.extendOwn({ discreteOnly: true, adRequired: true }, options);
    return MHKernel(cont, oldTrace, opts);
  }
  function LARJ_HMC_Kernel(cont, oldTrace, options) {
    var hmcSteps = options.hmcSteps;
    var hmcStepSize = options.hmcStepSize;
    function HMCdiffusion(cont, oldTrace, options) {
      var opts = _.extendOwn({
        steps: hmcSteps,
        stepSize: hmcStepSize  
      }, options);
      return HMCKernel(cont, oldTrace, opts);
    }
    var opts = _.extendOwn({
      jumpKernel: MHdiscreteAD,
      diffusionKernel: HMCdiffusion
    });
    return LARJKernel(cont, oldTrace, opts);
  }
  LARJ_HMC_Kernel.adRequired = true;

  // -------

  // Register all kernels
  registerKernel('MH', MHKernel);
  registerKernel('HMConly', HMCKernel);
  registerKernel('HMC', HMCwithMHKernel);
  registerKernel('LARJ_MH', LARJ_MH_Kernel);
  registerKernel('LARJ_HMC', LARJ_HMC_Kernel);


  return {
    parseOptions: parseOptions,
    tap: tap,
    sequence: sequence,
    repeat: repeat
  };

};
