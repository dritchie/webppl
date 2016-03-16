'use strict';

var _ = require('underscore');

module.exports = function(env) {

  var kutils = require('./utils')(env);

  var MHKernel = require('./mhkernel')(env);
  var HMCKernel = require('./hmckernel')(env);

  function HMCwithMHKernel(cont, oldTrace, options) {
    // The options arg is passed to both kernels as SMC passes
    // exitFactor via options.
    var opts = _.extendOwn({ discreteOnly: true, adRequired: true }, options);
    return HMCKernel(function(trace) {
      return MHKernel(cont, trace, opts);
    }, oldTrace, options);
  }

  HMCwithMHKernel.adRequired = true;

  // Register all kernels
  kutils.registerKernel('MH', MHKernel);
  kutils.registerKernel('HMConly', HMCKernel);
  kutils.registerKernel('HMC', HMCwithMHKernel);


  return {
    parseOptions: kutils.parseOptions,
    tap: kutils.tap,
    sequence: kutils.sequence,
    repeat: kutils.repeat
  };

};
