////////////////////////////////////////////////////////////////////
// Variational inference suite
//
// Structured like a particle filter, so that we can support
// variational particle filters / NASMC.

'use strict';

var _ = require('underscore');
var util = require('../util.js');
var erp = require('../erp.js');
var assert = require('assert');
var fs = require('fs');

var ad = require('adnn/ad');
var Tensor = require('adnn/tensor');


function hrtimeToSeconds(t) {
  // Seconds + nanoseconds
  return t[0] + t[1]/1e9;
}


module.exports = function(env) {

  function isActive(particle) {
    return particle.active;
  }

  function newParticle(s, k, optTrace) {
    return {
      continuation: k,
      weight: 0,
      targetScore: 0,
      guideScore: 0,
      reward: 0,
      value: undefined,
      store: _.clone(s),
      active: true,
      ancestor: -1,
      trace: optTrace
    };
  }

  function copyParticle(particle, ancestorIdx) {
    return {
      continuation: particle.continuation,
      weight: particle.weight,
      targetScore: particle.targetScore,
      guideScore: particle.guideScore,
      reward: particle.reward,
      value: particle.value,
      store: _.clone(particle.store),
      active: particle.active,
      ancestor: ancestorIdx,
      trace: particle.trace
    };
  }

  function Trace(choiceList) {
    this.choiceList = choiceList;
    this.index = 0;
  }
  Trace.prototype = {
    nextVal: function() {
      var val = this.choiceList[this.index];
      this.index++;
      return val;
    }
  };

  function avgWeight(particles) {
    var m = particles.length;
    var W = util.logsumexp(_.map(particles, function(p) {
      return p.weight;
    }));
    var avgW = W - Math.log(m);
    return avgW;
  }

  function readableParams(paramsObj) {
    var out = {};
    for (var name in paramsObj) {
      var plist = paramsObj[name];
      for (var i = 0; i < plist.length; i++) {
        var p = plist[i];
        out[p.name] = ad.value(p).toArray();
      }
    }
    return out;
  };

  function readableGradient(paramsObj, gradObj) {
    var out = {};
    for (var name in gradObj) {
      var glist = gradObj[name];
      var plist = paramsObj[name];
      for (var i = 0; i < glist.length; i++) {
        var g = glist[i];
        var p = plist[i];
        out[p.name] = g.toArray();
      }
    }
    return out;
  }

  function opt(opts, name, defaultval) {
    var o = opts[name];
    assert(o !== undefined || defaultval !== undefined,
      'Variatonal - option "' + name +'" must be defined!');
    return o === undefined ? defaultval : o;
  }

  function Variational(s, k, a, wpplFn, opts) {

    this.numParticles = opt(opts, 'numParticles');
    this.maxNumFlights = opt(opts, 'maxNumFlights');
    this.flightsLeft = this.maxNumFlights;
    this.convergeEps = opt(opts, 'convergeEps');
    this.verbosity = opt(opts, 'verbosity', {});
    this.regularizationWeight = opt(opts, 'regularizationWeight', 0);
    this.exampleTraces = opt(opts, 'exampleTraces', []);
    this.warnOnZeroGradient = opt(opts, 'warnOnZeroGradient', false);
    this.warnOnAnyZeroDerivative = opt(opts, 'warnOnAnyZeroDerivative', false);

    // How are we estimating stochastic gradients
    this.gradientEstimator = opt(opts, 'gradientEstimator');
    if (this.gradientEstimator === 'VPF') {
      this.estimateGradientImpl = this.estimateGradientVPF;
    } else if (this.gradientEstimator === 'ELBO') {
      this.estimateGradientImpl = this.estimateGradientELBO;
    } else if (this.gradientEstimator === 'EUBO') {
      assert(this.exampleTraces.length > 0, 'gradientEstimator EUBO requires exampleTraces');
      this.estimateGradientImpl = this.estimateGradientEUBO;
    } else {
      throw 'Unrecognized gradientEstimator ' + this.gradientEstimator;
    }

    // How are we updating parameters using estimated gradients
    var optimizerOpts = opt(opts, 'optimizer');
    if (optimizerOpts.name === 'adagrad') {
      var initLearnRate = opt(optimizerOpts, 'initLearnRate');
      this.optimizer = adagradOptimizer(initLearnRate);
    } else if (optimizerOpts.name === 'windowgrad') {
      var initLearnRate = opt(optimizerOpts, 'initLearnRate');
      var blendWeight = opt(optimizerOpts, 'blendWeight');
      this.optimizer = windowgradOptimizer(initLearnRate, blendWeight);
    } else if (optimizerOpts.name === 'adadelta') {
      var blendWeight = opt(optimizerOpts, 'blendWeight');
      this.optimizer = adadeltaOptimizer(blendWeight);
    } else if (optimizerOpts.name === 'adam') {
      var initLearnRate = opt(optimizerOpts, 'initLearnRate');
      var bw1 = opt(optimizerOpts, 'blendWeight1');
      var bw2 = opt(optimizerOpts, 'blendWeight2');
      this.optimizer = adamOptimizer(initLearnRate, bw1, bw2);
    } else if (optimizerOpts.name === 'sgd') {
      var initLearnRate = opt(optimizerOpts, 'initLearnRate');
      var decayFactor = opt(optimizerOpts, 'decayFactor');
      this.optimizer = sgdOptimizer(initLearnRate, decayFactor);
    } else {
      throw 'Unrecognized optimizer ' + this.optimizerOpts.name;
    }

    // Variational parameters
    this.params = {};

    // Convergence threshold
    this.maxDeltaAvg = 0;

    // Diagnostics
    this.diagnostics = {};

    // Move old coroutine out of the way and install this as the current
    // handler.
    this.k = k;
    this.oldCoroutine = env.coroutine;
    env.coroutine = this;

    this.oldStore = _.clone(s); // will be reinstated at the end
    this.wpplFn = wpplFn;
    this.addr = a;

    // Start timer
    this.startTime = process.hrtime();
  }

  Variational.prototype.runFlight = function() {
    if (this.verbosity.flightNum) {
      var flightId = this.maxNumFlights - this.flightsLeft + 1
      console.log('Running particle flight ' + flightId + '/' + this.maxNumFlights);
    }

    this.particles = [];
    this.particleHistory = [];
    this.particleIndex = 0;  // marks the active particle

    // Create initial particles
    var wpplFn = this.wpplFn;
    var a = this.addr;
    var exitK = function(s) {
      return wpplFn(s, env.exit, a);
    };
    for (var i = 0; i < this.numParticles; i++) {
      var trace = undefined;
      if (this.gradientEstimator === 'EUBO') {
        var ti = Math.floor(Math.random() * this.exampleTraces.length); 
        trace = new Trace(this.exampleTraces[ti]);
      }
      this.particles.push(newParticle(this.oldStore, exitK, trace));
    }

    // Run first particle
    return this.currentParticle().continuation(this.currentParticle().store);
  };

  Variational.prototype.sample = function(s, cc, a, erp, params) {
    var particle = this.currentParticle();
    var importanceERP = erp.importanceERP || erp;
    var val = particle.trace ? particle.trace.nextVal() : importanceERP.sample(params);
    var importanceScore = importanceERP.adscore(params, val);
    var choiceScore = erp.score(params, val);
    particle.weight += choiceScore - ad.value(importanceScore);
    particle.targetScore += choiceScore;
    particle.guideScore = ad.scalar.add(particle.guideScore, importanceScore);
    if (!isFinite(particle.weight)) {
      console.log('name: ' + a);
      console.log('erp: ' + erp.name);
      console.log('val: ' + val);
      console.log('prior params: ' + params);
      console.log('guide params: ' + importanceERP.rawparams);
      console.log('target score: ' + particle.targetScore);
      console.log('guide score: ' + ad.value(particle.guideScore));
      assert(false, 'Found non-finite particle weight!');
    }
    return cc(s, val);
  };

  Variational.prototype.factor = function(s, cc, a, score) {
    // Update particle weight
    var particle = this.currentParticle();
    particle.weight += score;
    particle.targetScore += score;
    particle.reward += score;
    particle.continuation = cc;
    particle.store = s;

    if (this.allParticlesAdvanced()) {
      // Resample in proportion to weights
      this.resampleParticles();
      // Resampling can kill all continuing particles
      var i = this.firstActiveParticleIndex();
      if (i === -1) {
        // All particles completed, no more computation to do
        return this.finish();
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

  Variational.prototype.firstActiveParticleIndex = function() {
    return util.indexOfPred(this.particles, isActive);
  };

  Variational.prototype.lastActiveParticleIndex = function() {
    return util.lastIndexOfPred(this.particles, isActive);
  };

  Variational.prototype.nextActiveParticleIndex = function() {
    var successorIndex = this.particleIndex + 1;
    var nextActiveIndex = util.indexOfPred(this.particles, isActive, successorIndex);
    if (nextActiveIndex === -1) {
      return this.firstActiveParticleIndex();  // wrap around
    } else {
      return nextActiveIndex;
    }
  };

  Variational.prototype.currentParticle = function() {
    return this.particles[this.particleIndex];
  };

  Variational.prototype.allParticlesAdvanced = function() {
    return this.particleIndex === this.lastActiveParticleIndex();
  };

  Variational.prototype.resampleParticles = function() {
    if (this.gradientEstimator !== 'VPF') {
      return;
    }
    // Residual resampling following Liu 2008; p. 72, section 3.4.4
    var m = this.particles.length;
    var avgW = avgWeight(this.particles);

    if (avgW === -Infinity) {      // debugging: check if NaN
      if (this.strict) {
        throw 'Error! All particles -Infinity';
      }
    } else {
      // Compute list of retained particles
      var retainedParticles = [];
      var newExpWeights = [];
      for (var p = 0; p < this.numParticles; p++) {
        var particle = this.particles[p];
        var w = Math.exp(particle.weight - avgW);
        var nRetained = Math.floor(w);
        newExpWeights.push(w - nRetained);
        for (var i = 0; i < nRetained; i++) {
          retainedParticles.push(copyParticle(particle, p));
        }
      }
      // Compute new particles
      var numNewParticles = m - retainedParticles.length;
      var newParticles = [];
      var j;
      for (var i = 0; i < numNewParticles; i++) {
        j = erp.multinomialSample(newExpWeights);
        newParticles.push(copyParticle(this.particles[j], j));
      }

      // Particles after update: Retained + new particles
      this.particles = newParticles.concat(retainedParticles);
      // Save particles to history
      this.particleHistory.push(this.particles);
    }

    // Reset all weights
    _.each(this.particles, function(particle) {
      particle.weight = avgW;
    });

    if (this.verbosity.numUniqueParticles) {
      var ids = {};
      var n = 0;
      for (var i = 0; i < this.numParticles; i++) {
        var id = this.particles[i].ancestor;
        if (!ids.hasOwnProperty(id)) {
          n++;
          ids[id] = true;
        }
      }
      console.log('  # unique particles after resample: ' + n);
    }
  };

  Variational.prototype.exit = function(s, retval) {
    var particle = this.currentParticle();
    particle.value = retval;
    if (this.verbosity.particleNum) {
      console.log('      Finished particle ' + this.particleIndex + '/' + this.numParticles);
    }
    particle.active = false;
    // Wait for all particles to reach exit before computing
    // marginal distribution from particles
    var i = this.nextActiveParticleIndex();
    if (i === -1) {
      // All particles completed
      return this.finish();
    } else {
      if (i < this.particleIndex) {
        // We have updated all particles and will now wrap around
        this.resampleParticles();
      }
      this.particleIndex = i;
      return this.currentParticle().continuation(this.currentParticle().store);
    }
  };

  Variational.prototype.finish = function() {
    this.flightsLeft--;
    if (this.verbosity.processRetVals) {
      this.verbosity.processRetVals(this.particles.map(function(p) { return p.value; }))
    }
    this.doGradientUpdate();
    this.computeDiagnostics();
    var converged = this.maxDeltaAvg < this.convergeEps;
    if (converged || this.flightsLeft === 0) {
      if (this.verbosity.endStatus) {
        if (converged) {
          console.log('CONVERGED (' + this.maxDeltaAvg + ' < ' + this.convergeEps + ')');
        } else {
          console.log('DID NOT CONVERGE (' + this.maxDeltaAvg + ' > ' + this.convergeEps +  ')');
        }
      }
      // Finalize return object
      this.diagnostics.converged = converged;
      this.diagnostics.flightsRun = this.maxNumFlights - this.flightsLeft;
      this.diagnostics.timeTaken = hrtimeToSeconds(process.hrtime(this.startTime));
      // Reinstate previous coroutine:
      env.coroutine = this.oldCoroutine;
      // Return from particle filter by calling original continuation:
      return this.k(this.oldStore, this.diagnostics);
    } else {
      // Run another flight
      return this.runFlight();
    }
  };

  Variational.prototype.computeDiagnostics = function() {
    var guideScore = 0;
    var targetScore = 0;
    var scoreDiff = 0;
    var totalTime = hrtimeToSeconds(process.hrtime(this.startTime));
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      var pgs = ad.value(p.guideScore);
      guideScore += pgs;
      targetScore += p.targetScore;
      scoreDiff += (p.targetScore - pgs);
    }
    guideScore /= this.numParticles;
    targetScore /= this.numParticles;
    scoreDiff /= this.numParticles;
    if (!this.diagnostics.hasOwnProperty('time')) {
      this.diagnostics.guideScore = [];
      this.diagnostics.targetScore = [];
      this.diagnostics.time = [];
      this.diagnostics.totalTime = [];
      this.diagnostics.avgTime = 0;
    }
    this.diagnostics.guideScore.push(guideScore);
    this.diagnostics.targetScore.push(targetScore);
    var n = this.diagnostics.time.length;
    var time = totalTime - (n === 0 ? 0 : this.diagnostics.totalTime[n-1]);
    this.diagnostics.totalTime.push(totalTime);
    this.diagnostics.time.push(time);
    this.diagnostics.avgTime = (n*this.diagnostics.avgTime + time) / (n + 1);
    if (this.verbosity.guideScore) {
      console.log('  guideScore: ' + guideScore);
    }
    if (this.verbosity.guideScoreAvg) {
      var nTotal = this.diagnostics.guideScore.length;
      var nBack = this.verbosity.guideScoreAvg;
      var iStart = Math.max(0, nTotal - nBack);
      var n = nTotal - iStart;
      var avg = 0;
      for (var i = iStart; i < nTotal; i++) {
        avg += this.diagnostics.guideScore[i];
      }
      avg /= n;
      console.log('  guideScore (avg of last ' + n + '): ' + avg);
    }
    if (this.verbosity.targetScore) {
      console.log('  targetScore: ' + targetScore);
    }
    if (this.verbosity.scoreDiff) {
      console.log('  scoreDiff: ' + scoreDiff);
    }
    if (this.verbosity.time) {
      console.log('  time elapsed: ' + totalTime + ' (avg per flight: ' + this.diagnostics.avgTime + ')');
    }
  };

  // Given a list of tensors, return a list of zero tensors of the same dimensions
  function zeros(tensors) {
    return tensors.map(function(x) { return new Tensor(x.dims); });
  }

  // Optimizers mutate the gradient to reflect the actual delta performed
  //    to the params

  function sgdOptimizer(initLearnRate, decayFactor) {
    var learnRate = initLearnRate;
    return function(t, name, gradlist, paramlist) {
      for (var i = 0; i < gradlist.length; i++) {
        var grad = gradlist[i];
        var params = ad.value(paramlist[i]);
        params.addeq(grad.muleq(learnRate));
      }
      learnRate *= decayFactor;
    };
  }

  function adagradOptimizer(initLearnRate) {
    var runningG2 = {};
    return function(t, name, gradlist, paramlist) {
      if (!runningG2.hasOwnProperty(name)) {
        runningG2[name] = zeros(gradlist);
      }
      for (var i = 0; i < gradlist.length; i++) {
        var grad = gradlist[i];
        var params = ad.value(paramlist[i]);
        var rg2 = runningG2[name][i];
        rg2.addeq(grad.mul(grad));
        var weight = rg2.sqrt().pseudoinverteq().muleq(initLearnRate);
        if (!weight.isFinite().allreduce()) {
          console.log('Found non-finite AdaGrad weight!');
          console.log('name: ' + paramlist[i].name);
          console.log('grad: ' + JSON.stringify(grad.toArray()));
          console.log('weight: ' + JSON.stringify(weight.toArray()));
          assert(false);
        }
        params.addeq(grad.muleq(weight));
      }
    };
  }

  function windowgradOptimizer(initLearnRate, blendWeight) {
    var runningG2 = {};
    return function(t, name, gradlist, paramlist) {
      if (!runningG2.hasOwnProperty(name)) {
        runningG2[name] = zeros(gradlist);
      }
      for (var i = 0; i < gradlist.length; i++) {
        var grad = gradlist[i];
        var params = ad.value(paramlist[i]);
        var rg2 = runningG2[name][i];
        var g2 = grad.mul(grad).muleq(1 - blendWeight);
        rg2.muleq(blendWeight).addeq(g2);
        var weight = rg2.sqrt().pseudoinverteq().muleq(initLearnRate);
        if (!weight.isFinite().allreduce()) {
          console.log('Found non-finite WindowGrad weight!');
          console.log('name: ' + paramlist[i].name);
          console.log('grad: ' + JSON.stringify(grad.toArray()));
          console.log('weight: ' + JSON.stringify(weight.toArray()));
          assert(false);
        }
        params.addeq(grad.muleq(weight));
      }
    };
  }

  function adadeltaOptimizer(blendWeight) {
    var runningG2 = {};
    var runningX2 = {};
    return function(t, name, gradlist, paramlist) {
      if (!runningG2.hasOwnProperty(name)) {
        runningG2[name] = zeros(gradlist);
        runningX2[name] = zeros(gradlist);
      }
      for (var i = 0; i < gradlist.length; i++) {
        var grad = gradlist[i];
        var params = ad.value(paramlist[i]);
        var rg2 = runningG2[name][i];
        var rx2 = runningX2[name][i];
        var g2 = grad.mul(grad).muleq(1 - blendWeight);
        rg2.muleq(blendWeight).addeq(g2);
        var weight = rg2.sqrt().pseudoinverteq().muleq(rx2);
        if (!weight.isFinite().allreduce()) {
          console.log('Found non-finite AdaDelta weight!');
          console.log('name: ' + paramlist[i].name);
          console.log('grad: ' + JSON.stringify(grad.toArray()));
          console.log('weight: ' + JSON.stringify(weight.toArray()));
          assert(false);
        }
        var dx = grad.muleq(weight);
        params.addeq(dx);
        dx.muleq(dx).muleq(1 - blendWeight);
        rx2.muleq(blendWeight).addeq(dx);
      }
    };
  }

  function adamOptimizer(initLearnRate, blendWeight1, blendWeight2) {
    var firstMom = {};
    var secondMom = {};
    return function(t, name, gradlist, paramlist) {
      var bwPow1 = Math.pow(blendWeight1, t);
      var bwPow2 = Math.pow(blendWeight2, t);
      if (!firstMom.hasOwnProperty(name)) {
        firstMom[name] = zeros(gradlist);
        secondMom[name] = zeros(gradlist);
      }
      var mom1 = firstMom[name];
      var mom2 = secondMom[name];
      for (var i = 0; i < gradlist.length; i++) {
        var params = ad.value(paramlist[i]);
        var grad = gradlist[i];
        var gradSq = grad.mul(grad);
        var m1 = mom1[i];
        var m2 = mom2[i];
        m1.muleq(blendWeight1).addeq(grad.muleq(1 - blendWeight1));
        m2.muleq(blendWeight2).addeq(gradSq.muleq(1 - blendWeight2));
        var firstCorr = m1.div(1 - bwPow1);
        var secondCorr = m2.div(1 - bwPow2);
        var dx = firstCorr.muleq(initLearnRate).muleq(secondCorr.sqrteq().pseudoinverteq());
        if (!dx.isFinite().allreduce()) {
          console.log('Found non-finite Adam update!');
          console.log('name: ' + paramlist[i].name);
          console.log('grad: ' + JSON.stringify(grad.toArray()));
          console.log('dx: ' + JSON.stringify(dx.toArray()));
          assert(false);
        }
        params.addeq(dx);
      }
    };
  }

  Variational.prototype.doGradientUpdate = function() {
    if (this.verbosity.params) {
      console.log('  params before update: ' + JSON.stringify(readableParams(this.params)));
    }
    var iterNum = this.maxNumFlights - this.flightsLeft + 1;
    var gradient = this.estimateGradient();
    var maxDelta = 0;
    for (var name in gradient) {
      var gradlist = gradient[name];
      var paramlist = this.params[name];

      // Do regularization, if requested
      if (this.regularizationWeight > 0) {
        for (var i = 0; i < gradlist.length; i++) {
          var grad = gradlist[i];
          var params = ad.value(paramlist[i]);
          grad.subeq(params.mul(this.regularizationWeight));
        }
      }

      // Do gradient update
      // (Destructively updates the gradient to reflect the actual
      //    delta done to the params)
      this.optimizer(iterNum, name, gradlist, paramlist);

      // Computer convergence test stat
      for (var i = 0; i < gradlist.length; i++) {
        var grad = gradlist[i];
        maxDelta = Math.max(grad.abs().maxreduce(), maxDelta);
      }
    }
    this.maxDeltaAvg = this.maxDeltaAvg * 0.9 + maxDelta;
    if (this.verbosity.params) {
      console.log('  params after update: ' + JSON.stringify(readableParams(this.params)));
    }
  };

  Variational.prototype.estimateGradient = function() {
    var gradient = this.estimateGradientImpl();
    if (this.verbosity.gradientEstimate) {
      console.log('  gradientEst: ' + JSON.stringify(readableGradient(this.params, gradient)));
    }
    return gradient;
  };

  Variational.prototype.estimateGradientVPF = function() {
    // TODO: Use particle ancestor tree to avoid even more unnecessary recomputation(?)
    var sumGrad = {};
    for (var t = 0; t < this.particleHistory.length; t++) {
      var particles = this.particleHistory[t];
      var avgW = avgWeight(particles);
      var groupedParticles = groupByAncestor(particles);
      for (var i = 0; i < groupedParticles.length; i++) {
        var group = groupedParticles[i];
        var n = group.length;
        var rep = group[0];
        var w = n * Math.exp(rep.weight - avgW);
        var gradient = this.getParticleGradient(rep, true); // zero all derivatives
        for (var name in gradient) {
          var gradlist = gradient[name];
          if (!sumGrad.hasOwnProperty(name)) {
            sumGrad[name] = zeros(gradlist);
          }
          for (var j = 0; j < gradlist.length; j++) {
            sumGrad[name][j].addeq(gradlist[j].muleq(w));
          }
        }
      }
    };
    return sumGrad;
  };

  function groupByAncestor(particles) {
    var groups = {};
    for (var p = 0; p < particles.length; p++) {
      var particle = particles[p];
      var id = particle.ancestor;
      if (!groups.hasOwnProperty(id)) {
        groups[id] = [];
      }
      groups[id].push(particle);
    }
    var list = [];
    for (var name in groups) {
      list.push(groups[name]);
    }
    return list;
  }

  Variational.prototype.estimateGradientELBO = function() {
    var sumGrad = {};
    var sumWeightedGrad = {};
    var sumGradSq = {};
    var sumWeightedGradSq = {};
    for (var i = 0; i < this.particles.length; i++) {
      var particle = this.particles[i];
      var weight = particle.targetScore - ad.value(particle.guideScore);
      var gradient = this.getParticleGradient(particle);
      for (var name in gradient) {
        var gradlist = gradient[name];
        if (!sumGrad.hasOwnProperty(name)) {
          sumGrad[name] = zeros(gradlist);
          sumWeightedGrad[name] = zeros(gradlist);
          sumGradSq[name] = zeros(gradlist);
          sumWeightedGradSq[name] = zeros(gradlist);
        }
        for (var j = 0; j < gradlist.length; j++) {
          var g = gradlist[j];
          sumGrad[name][j].addeq(g);
          var weightedGrad = g.mul(weight);
          sumWeightedGrad[name][j].addeq(weightedGrad);
          g.muleq(g); // g -> g^2
          sumGradSq[name][j].addeq(g);
          g.muleq(weight); // g -> weightedGradSq
          sumWeightedGradSq[name][j].addeq(g);
        }
      }
    }
    // Control variate
    var aStar = {};
    var elboGradEst = {};
    for (var name in sumGrad) {
      var n = sumGrad[name].length;
      aStar[name] = new Array(n);
      elboGradEst[name] = new Array(n);
      for (var i = 0; i < n; i++) {
        // Overwrite a bunch of temporaries to save space
        aStar[name][i] = sumGradSq[name][i].pseudoinverteq().muleq(sumWeightedGradSq[name][i]);
        elboGradEst[name][i] = sumWeightedGrad[name][i].subeq(
          sumGrad[name][i].muleq(aStar[name][i])).diveq(this.numParticles);
      }
    }
    return elboGradEst;
  };

  Variational.prototype.estimateGradientEUBO = function() {
    var sumGrad = {};
    for (var i = 0; i < this.particles.length; i++) {
      var particle = this.particles[i];
      var gradient = this.getParticleGradient(particle);
      for (var name in gradient) {
        var gradlist = gradient[name];
        if (!sumGrad.hasOwnProperty(name)) {
          sumGrad[name] = zeros(gradlist);
        }
        for (var j = 0; j < gradlist.length; j++) {
          sumGrad[name][j].addeq(gradlist[j]);
        }
      }
    }
    for (var name in sumGrad) {
      var gradlist = sumGrad[name];
      for (var j = 0; j < gradlist.length; j++) {
        sumGrad[name][j].diveq(this.numParticles);
      }
    }
    return sumGrad;
  };

  // If zeroAllDerivs is true, this will zero all derivatives along the backprop graph.
  // Otherwise, it will just zero the derivatives at the parameters.
  // Reasoning: VPF needs to zero everything, since the backprop graphs for different
  //    particles are intertwined (due to resampling). The other methods have independent
  //    backprop graphs, so there's no interference and no need to zero anything except
  //    the parameter derivs (since all the independent graphs start there).
  Variational.prototype.getParticleGradient = function(particle, zeroAllDerivs) {
    // Backpropagate gradients
    particle.guideScore.backprop();
    // Extract gradient from params
    var gradient = _.mapObject(this.params, function(paramslist, name) {
      return paramslist.map(function(params, i) {
        var grad = ad.derivative(params).clone();
        if (!zeroAllDerivs) {
          // Just zero the parameter derivatives.
          params.zeroDerivatives();
        }
        // (Optionally) warn about zeros in the derivatives
        var gradIsZero = false;
        if (this.warnOnZeroGradient && !grad.anyreduce()) {
          gradIsZero = true;
          console.log("  -- WARN: Parameter '" + params.name + "' has a completely zero gradient --");
        }
        if (this.warnOnAnyZeroDerivative && !gradIsZero && !grad.allreduce()) {
          console.log("  -- WARN: Parameter '" + params.name + "' has some zero(s) in its gradient --");
        }
        return grad;
      }.bind(this));
    }.bind(this));
    if (this.verbosity.gradientSamples) {
      console.log('    gradientSamp: ' + JSON.stringify(readableGradient(this.params, gradient)));
    }
    if (zeroAllDerivs) {
      // Zero all derivatives along the backprop graph.
      particle.guideScore.zeroDerivatives();
    }
    return gradient;
  };

  Variational.prototype.incrementalize = env.defaultCoroutine.incrementalize;

  function VI(s, cc, a, wpplFn, opts) {
    return new Variational(s, cc, a, wpplFn, opts).runFlight();
  }


  // Globally-available functions for registering optimizable parameters
  VI.registerParams = function(name, params) {
    if (env.coroutine instanceof Variational) {
      env.coroutine.params[name] = params;
    }
  };
  function registerVariationalParams(s, k, a, params) {
    VI.registerParams(a, params);
    return k(s);
  }


  function adValueRecursive(lst) {
    return lst.map(function(x) {
      return _.isArray(x) ? adValueRecursive(x) : ad.value(x);
    });
  }


  // For each ERP, define a guide version that uses its own stored parameters
  //    instead of the parameters passed to its sample and score functions.
  for (var propname in erp) {
    var prop = erp[propname];
    if (typeof(prop) === 'object' && prop instanceof erp.ERP) {
      var erpObj = prop;
      var impErpObj = _.extend(_.clone(erpObj), {
        baseERP: erpObj,
        setParams: function(params) {
          this.params = params;
          // this.rawparams = params.map(ad.value);
          this.rawparams = adValueRecursive(params);
        },
        sample: function(params) { return this.baseERP.sample(this.rawparams); },
        score: function(params, val) { return this.baseERP.score(this.rawparams, val); },
        adscore: function(params, val) { return this.baseERP.adscore(this.params, val); }
      });
      VI[propname] = impErpObj;
    }
  }


  return {
    Variational: VI,
    registerVariationalParams: registerVariationalParams
  };

};