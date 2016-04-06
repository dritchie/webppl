////////////////////////////////////////////////////////////////////
// Inference interface
//
// An inference function takes the current continuation and a WebPPL
// thunk (which itself has been transformed to take a
// continuation). It does some kind of inference and returns an ERP
// representing the nromalized marginal distribution on return values.
//
// The inference function should install a coroutine object that
// provides sample, factor, and exit.
//
// sample and factor are the co-routine handlers: they get call/cc'ed
// from the wppl code to handle random stuff.
//
// The inference function passes exit to the wppl fn, so that it gets
// called when the fn is exited, it can call the inference cc when
// inference is done to contintue the program.

'use strict';

var assert = require('assert');
var _ = require('underscore');

try {
  var util = require('./util');
  var erp = require('./erp');
  var enumerate = require('./inference/enumerate');
  var mcmc = require('./inference/mcmc');
  var asyncpf = require('./inference/asyncpf');
  var pmcmc = require('./inference/pmcmc');
  var smc = require('./inference/smc');
  var pf = require('./inference/oldParticleFilter');
  var variational = require('./inference/variational');
  var rejection = require('./inference/rejection');
  var incrementalmh = require('./inference/incrementalmh');
  var headerUtils = require('./headerUtils');
  var Query = require('./query').Query;
  var ad = require('./ad');
} catch (e) {
  if (e.code === 'MODULE_NOT_FOUND') {
    console.error(e.message);
    console.error('Run ./script/adify and try again.');
    process.exit();
  } else {
    throw e;
  }
}

module.exports = function(env) {


  // Inference interface

  env.coroutine = {
    sample: function(s, k, a, erp, params) {
      return k(s, erp.sample(params));
    },
    factor: function() {
      throw 'factor allowed only inside inference.';
    },
    exit: function(s, r) {
      return r;
    },
    incrementalize: function(s, k, a, fn, args) {
      var args = [s, k, a].concat(args);
      return fn.apply(global, args);
    }
  };

  env.defaultCoroutine = env.coroutine;

  env.sample = function(s, k, a, erp, params) {
    return env.coroutine.sample(s, k, a, erp, params);
  };

  env.factor = function(s, k, a, score) {
    assert.ok(!isNaN(ad.untapify(score)), 'factor() score was NaN');
    return env.coroutine.factor(s, k, a, score);
  };

  env.sampleWithFactor = function(s, k, a, erp, params, scoreFn) {
    if (typeof env.coroutine.sampleWithFactor === 'function') {
      return env.coroutine.sampleWithFactor(s, k, a, erp, params, scoreFn);
    } else {
      var sampleK = function(s, v) {
        var scoreK = function(s, sc) {
          var factorK = function(s) {
            return k(s, v);
          };
          return env.factor(s, factorK, a + 'swf2', sc);
        };
        return scoreFn(s, scoreK, a + 'swf1', v);
      };
      return env.sample(s, sampleK, a, erp, params);
    }
  };

  env.exit = function() {
    return env.coroutine.exit.apply(env.coroutine, arguments);
  };

  env.incrementalize = function(s, k, a, fn, args) {
    args = args || [];
    return env.coroutine.incrementalize(s, k, a, fn, args);
  };

  // Inference coroutines are responsible for managing this correctly.
  env.query = new Query();


  // Exports

  var exports = {
    _top: util.runningInBrowser() ? window : global
  };

  function addExports(obj) {
    _.extend(exports, obj);
  }

  // Inference interface
  addExports({
    factor: env.factor,
    sample: env.sample,
    sampleWithFactor: env.sampleWithFactor,
    incrementalize: env.incrementalize,
    query: env.query
  });

  // Modules we want to use from webppl
  addExports({
    _: _,
    util: util,
    assert: assert,
    ad: ad
  });

  // Inference functions and header utils
  var headerModules = [
    enumerate, asyncpf, mcmc, incrementalmh, pmcmc,
    smc, variational, rejection, headerUtils,
    pf
  ];
  headerModules.forEach(function(mod) {
    addExports(mod(env));
  });

  // Random primitives
  addExports(erp);

  return exports;

};
