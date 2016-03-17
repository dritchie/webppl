'use strict';

var ad = require('../../ad');

// TODO:
//   - Check consistency after running? (i.e. throw error if structure has changed,
//     by checking if any addresses were added/removed).
//     * Related: When MHKernel is in 'continuousOnly' mode, have it throw an error
//       if it couldn't find prevChoice (like what HMC does).
//   - Optionally have 'info' on interpolation traces so we can record annealing
//       acceptance ratio?

// Trace methods used by MH / HMC:
//  - uptoAndIncluding
//  - upto(?)
//  - saveContinuation
//  - continue
function InterpolationTrace(trace1, trace2) {
  this.trace1 = trace1;
  this.trace2 = trace2;
  this.alpha = 0;

  // TODO: Build merged list of choices
  this.choices = [];
}

Object.defineProperty(InterpolationTrace.prototype, 'score', {
  get: function() {
    return ad.add(
      ad.mul(1-this.alpha, this.trace1.score),
      ad.mul(alpha, this.trace2.score)
    );
  }
});

Object.defineProperty(InterpolationTrace.prototype, 'length', {
  get: function() {
    return this.choices.length;
  }
});

InterpolationTrace.prototype.fresh = function() {
  var t1 = this.trace1.fresh();
  var t2 = this.trace2.fresh();
  var it = new InterpolationTrace(t1, t2);
  it.alpha = this.alpha;
  return it;
};

InterpolationTrace.prototype.choiceAtIndex = function(i) {
  return this.choices[i];
};

InterpolationTrace.prototype.findChoice = function(address) {
  return this.trace1.findChoice(address) || this.trace2.findChoice(address);
};

InterpolationTrace.prototype.complete = function(val) {
  this.trace1.complete(val);
  this.trace2.complete(val);
};

InterpolationTrace.prototype.isComplete = function() {
  return this.trace1.isComplete() && this.trace2.isComplete();
};


// TODO:
//   - Jump proposals need to respect 'proposalBoundary', and we need to
//     pass 'proposalBoundary' to the diffusion kernel as well.
//   - Have a list of permitted diffusion kernels? (i.e. HMConly, MH with continuousOnly)

module.exports = function(env) {

	var kutils = require('./utils')(env);

	return function(cont, oldTrace, options) {

	};
};


