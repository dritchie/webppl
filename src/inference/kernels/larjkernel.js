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
//  - saveContinuation
//  - continue
function InterpolationTrace(trace1, trace2, alpha) {
  this.trace1 = trace1;
  this.trace2 = trace2;
  this.alpha = (alpha === undefined) ? 0 : alpha;

  // Build merged list of choices

  this.choices = [];
  var i = 0;
  var j = 0;
  // Simultaneously iterate over choices of both traces
  for (; i < trace1.choices.length && j < trace2.choices.length; i++, j++) {
    var c1 = trace1.choices[i];
    var c2 = trace2.choices[j];
    // If both traces have the same choice at this index, add it once
    if (c1.address === c2.address) {
      this.choices.push(c1);
    // If trace2 has choice c1 somewhere later on, add all choices
    //    from trace2 up to choice c1, then add c1 itself
    } else if (trace2.findChoice(c1.address)) {
      var c12 = trace2.findChoice(c1.address);
      for (; j < c12.index; j++)
        this.choices.push(trace2.choices[j]);
      this.choices.push(c1);
    // Analogous case to the above, but with trace1 and trace2 swapped
    } else if (trace1.findChoice(c2.address)) {
      var c21 = trace1.findChoice(c2.address);
      for (; i < c21.index; i++)
        this.choices.push(trace1.choices[i]);
      this.choices.push(c2);
    // If the choices at this index are unique to each trace, add them both
    } else {
      this.choices.push(c1);
      this.choices.push(c2);
    }
  }
  // Deal with any leftover choices (at most one of these loops will execute)
  for (; i < trace1.choices.length; i++) {
    this.choices.push(trace1.choices[i]);
  }
  for (; j < trace2.choices.length; j++) {
    this.choices.push(trace2.choices[j]);
  }
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
  return new InterpolationTrace(t1, t2, this.alpha);
};

InterpolationTrace.prototype.choiceAtIndex = function(i) {
  return this.choices[i];
};

InterpolationTrace.prototype.findChoice = function(address) {
  return this.trace1.findChoice(address) || this.trace2.findChoice(address);
};

InterpolationTrace.prototype.saveContinuation = function(s, k) {
  this.store = s;
  this.k = k;
};

InterpolationTrace.prototype.complete = function(val) {
  this.trace1.complete(val);
  this.trace2.complete(val);
  this.store = undefined;
  this.k = undefined;
};

InterpolationTrace.prototype.isComplete = function() {
  return this.trace1.isComplete() && this.trace2.isComplete();
};

InterpolationTrace.prototype.upToAndIncluding = function(i) {
  var t1 = this.__upToAndIncluding(i, this.trace1);
  var t2 = this.__upToAndIncluding(i, this.trace2);
  return new InterpolationTrace(t1, t2, this.alpha);
};
InterpolationTrace.prototype.__upToAndIncluding = function(i, trace) {
  var address = this.choices[i].address;
  var t;
  var c = trace.findChoice(address);
  // If trace has this choice, take everything up to and including it
  if (c !== undefined) {
    t = trace.upToAndIncluding(c.index);
  } else {
    // Find next choice that trace does have, take everything up to that
    for (; i < this.choices.length; i++) {
      c = trace.findChoice(this.choices[i].address);
      if (c !== undefined) break;
    }
    if (c !== undefined) {
      t = trace.upto(c.index);
    } else {
      // If no such choice, then take the whole trace
      t = trace.upToAndIncluding(trace.length - 1);
      // TODO: This trace actually doesn't need to be re-run at all when we propose
      //    a change to the choice at index i. Can we achieve this by marking this
      //    trace somehow? (And maybe use trace.copy() instead?)
    }
  }
  return t;
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


