////////////////////////////////////////////////////////////////////
// Particle filtering
//
// Sequential importance re-sampling, which treats 'factor' calls as
// the synchronization / intermediate distribution points.
//
// dritchie: this is old legacy code; I want to see if it's any faster
//    than the current version in smc.js

'use strict';

var _ = require('underscore');
var util = require('../util.js');
var erp = require('../erp.js');

function isActive(particle) {
  return particle.active;
}

function hrtimeToSeconds(t) {
  // Seconds + nanoseconds
  return t[0] + t[1]/1e9;
}

module.exports = function(env) {

  function withImportanceDist(s, k, a, erp, importanceERP) {
    var newERP = _.clone(erp);
    newERP.importanceERP = importanceERP;
    return k(s, newERP);
  }

  function copyParticle(particle) {
    return {
      continuation: particle.continuation,
      weight: particle.weight,
      value: particle.value,
      store: _.clone(particle.store),
      active: particle.active,
      trace: particle.trace.slice(),
      logprior: particle.logprior,
      loglike: particle.loglike,
      logpost: particle.logpost,
      id: particle.id,
    };
  }

  function ParticleFilter(s, k, a, wpplFn, numParticles, strict, saveHistory, noHistogram) {

    this.particles = [];
    this.particleIndex = 0;  // marks the active particle

    this.nextParticleId = 0;

    // Create initial particles
    var exitK = function(s) {
      return wpplFn(s, env.exit, a);
    };
    for (var i = 0; i < numParticles; i++) {
      var particle = {
        continuation: exitK,
        weight: 0,
        score: 0,
        value: undefined,
        store: _.clone(s),
        active: true,
        trace: [],
        logprior: 0,
        loglike: 0,
        logpost: 0,
        id: this.nextParticleId++,
      };
      this.particles.push(particle);
    }

    this.strict = strict;

    if (saveHistory) {
      this.particleHistory = [];
      // 'saveHistory' can be a function, in which case we apply this function
      //    to all particles before they get saved to the history.
      if (_.isFunction(saveHistory)) {
        this.processHistoryParticle = saveHistory;
      } else {
        this.processHistoryParticle = function(p) { return p; };
      }
    }

    this.noHistogram = noHistogram;

    // Move old coroutine out of the way and install this as the current
    // handler.
    this.k = k;
    this.oldCoroutine = env.coroutine;
    env.coroutine = this;

    this.oldStore = _.clone(s); // will be reinstated at the end

    // Start timer
    this.startTime = process.hrtime();
  }

  ParticleFilter.prototype.run = function() {
    // Run first particle
    return this.currentParticle().continuation(this.currentParticle().store);
  };

  ParticleFilter.prototype.sample = function(s, cc, a, erp, params) {
    var importanceERP = erp.importanceERP || erp;
    var val = importanceERP.sample(params);
    var choiceScore = erp.score(params, val);
    var importanceScore = erp === importanceERP ? choiceScore : importanceERP.score(params, val);
    var p = this.currentParticle();
    p.weight += choiceScore - importanceScore;
    p.logprior += choiceScore;
    p.logpost += choiceScore;
    p.trace.push(val);
    p.id = this.nextParticleId++;
    return cc(s, val);
  };

  ParticleFilter.prototype.factor = function(s, cc, a, score) {
    // Update particle weight
    var p = this.currentParticle();
    p.weight += score;
    p.loglike += score;
    p.logpost += score;
    p.continuation = cc;
    p.store = s;

    if (this.allParticlesAdvanced()) {
      // Resample in proportion to weights
      this.resampleParticles();
      // Resampling can kill all continuing particles
      var i = this.firstActiveParticleIndex();
      if (i === -1) {
        // All particles completed, no more computation to do
        return this.finish(s);
      } else {
        this.particleIndex = i;
      }
    } else {
      // Advance to the next particle
      this.particleIndex = this.nextActiveParticleIndex();
    }

    return this.currentParticle().continuation(this.currentParticle().store);
  };

  // The three functions below return -1 if there is no active particle

  ParticleFilter.prototype.firstActiveParticleIndex = function() {
    return util.indexOfPred(this.particles, isActive);
  };

  ParticleFilter.prototype.lastActiveParticleIndex = function() {
    return util.lastIndexOfPred(this.particles, isActive);
  };

  ParticleFilter.prototype.nextActiveParticleIndex = function() {
    var successorIndex = this.particleIndex + 1;
    var nextActiveIndex = util.indexOfPred(this.particles, isActive, successorIndex);
    if (nextActiveIndex === -1) {
      return this.firstActiveParticleIndex();  // wrap around
    } else {
      return nextActiveIndex;
    }
  };

  ParticleFilter.prototype.currentParticle = function() {
    return this.particles[this.particleIndex];
  };

  ParticleFilter.prototype.allParticlesAdvanced = function() {
    return this.particleIndex === this.lastActiveParticleIndex();
  };

  ParticleFilter.prototype.resampleParticles = function() {
    // Residual resampling following Liu 2008; p. 72, section 3.4.4
    var m = this.particles.length;
    var W = util.logsumexp(_.map(this.particles, function(p) {
      return p.weight;
    }));
    var avgW = W - Math.log(m);

    if (avgW === -Infinity) {      // debugging: check if NaN
      if (this.strict) {
        throw 'Error! All particles -Infinity';
      }
    } else {
      var time = hrtimeToSeconds(process.hrtime(this.startTime));

      // Compute list of retained particles
      var retainedParticles = [];
      var newExpWeights = [];
      for (var i = 0; i < this.particles.length; i++) {
        var particle = this.particles[i];
        var w = Math.exp(particle.weight - avgW);
        var nRetained = Math.floor(w);
        newExpWeights.push(w - nRetained);
        for (var j = 0; j < nRetained; j++) {
          retainedParticles.push(copyParticle(particle));
        }
      }
      // Compute new particles
      var numNewParticles = m - retainedParticles.length;
      var newParticles = [];
      var j;
      for (var i = 0; i < numNewParticles; i++) {
        j = erp.discreteSample(newExpWeights);
        newParticles.push(copyParticle(this.particles[j]));
      }

      // Store pre-resample particles to history
      if (this.particleHistory) {
        var proc = this.processHistoryParticle;
        this.particleHistory.push(this.particles.map(function(p) {
          var cp = copyParticle(p);  // To properly preserve this state
          cp.time = time;
          proc(cp);
          return cp;
        }));
      }
      // Particles after update: Retained + new particles
      this.particles = newParticles.concat(retainedParticles);
      // Story post-resample particles to history
      if (this.particleHistory) {
        var proc = this.processHistoryParticle;
        this.particleHistory.push(this.particles.map(function(p) {
          var cp = copyParticle(p);  // To properly preserve this state
          cp.time = time;
          proc(cp);
          return cp;
        }));
      }
    }

    // Reset all weights
    _.each(this.particles, function(particle) {
      particle.weight = avgW;
    });
  };

  ParticleFilter.prototype.exit = function(s, retval) {
    this.currentParticle().value = retval;
    this.currentParticle().active = false;
    this.currentParticle().id = this.nextParticleId++;
    // Wait for all particles to reach exit before computing
    // marginal distribution from particles
    var i = this.nextActiveParticleIndex();
    if (i === -1) {
      // All particles completed
      return this.finish(s);
    } else {
      if (i < this.particleIndex) {
        // We have updated all particles and will now wrap around
        this.resampleParticles();
         // Resampling can kill all continuing particles
        i = this.firstActiveParticleIndex();
        if (i === -1) {
          // All particles completed, no more computation to do
          return this.finish(s);
        }
      }
      this.particleIndex = i;
      return this.currentParticle().continuation(this.currentParticle().store);
    }
  };

  ParticleFilter.prototype.finish = function(s) {
    // Compute marginal distribution from (unweighted) particles
    var dist = {};
    if (!this.noHistogram) {
      var hist = {};
      _.each(
          this.particles,
          function(particle) {
            var k = JSON.stringify(particle.value);
            if (hist[k] === undefined) {
              hist[k] = {prob: 0, val: particle.value};
            }
            hist[k].prob += 1;
          });
      dist = erp.makeMarginalERP(util.logHist(hist));
    }

    // Save estimated normalization constant in erp (average particle weight)
    dist.normalizationConstant = this.particles[0].weight;

    ////
    // Save the MAP particle
    var bestLP = -Infinity;
    var besti = -1;
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      if (p.logpost > bestLP) {
        bestLP = p.logpost;
        besti = i;
      }
    }
    dist.MAPparticle = this.particles[besti];
    // Save the particle history
    if (this.particleHistory) {
      var time = hrtimeToSeconds(process.hrtime(this.startTime));
      dist.particleHistory = this.particleHistory;
      dist.particleHistory.push(this.particles.map(function(p) {
        var cp = copyParticle(p);
        cp.time = time;
        return cp;
      }));
    } else {
      dist.particleHistory = [this.particles];
    }
    // Save the store from the last particle to finish (I found at least one
    //    case where I want this, for inspection purposes)
    dist.finalStore = s;
    ////

    // Reinstate previous coroutine:
    env.coroutine = this.oldCoroutine;

    // Return from particle filter by calling original continuation:
    return this.k(this.oldStore, dist);
  };

  ParticleFilter.prototype.incrementalize = env.defaultCoroutine.incrementalize;

  function pf(s, cc, a, wpplFn, numParticles, strict, saveHistory, noHistogram) {
    return new ParticleFilter(s, cc, a, wpplFn, numParticles,
      strict === undefined ? true : strict,
      saveHistory === undefined ? false : saveHistory,
      noHistogram === undefined ? false : noHistogram).run();
  }

  return {
    OldParticleFilter: pf,
    withImportanceDist: withImportanceDist
  };

};
