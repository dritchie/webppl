'use strict';

var ad = require('../../ad');
var util = require('../../util');


module.exports = function(env) {

  // TODO:
  //   - Check consistency after running? (i.e. throw error if structure has changed,
  //     by checking if any addresses were added/removed).
  //   - Optionally have 'info' on interpolation traces so we can record annealing
  //       acceptance ratio?

  function InterpolationTrace(trace1, trace2, larjKernel, alpha) {
    this.trace1 = trace1;
    this.trace2 = trace2;
    this.larjKernel = larjKernel;
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
    return new InterpolationTrace(t1, t2, this.larjKernel, this.alpha);
  };

  InterpolationTrace.prototype.choiceAtIndex = function(i) {
    return this.choices[i];
  };

  InterpolationTrace.prototype.findChoice = function(address) {
    return this.trace1.findChoice(address) || this.trace2.findChoice(address);
  };

  InterpolationTrace.prototype.saveContinuation = function(s, k) {
    this.trace1.saveContinuation(s, k);
    this.trace2.saveContinuation(s, k);
  };

  // This interacts with LARJKernel.exit to ensure that both subtraces
  //    are continued.
  InterpolationTrace.prototype.continue = function() {
    // LARJ kernel assumes control
    env.coroutine = this.larjKernel;
    // Case 1: We have yet to execute the first trace
    if (this.larjKernel.diffusionKernel.trace === this) {
      this.larjKernel.diffusionKernel.trace = this.trace1;
      return this.trace1.continue();
    // Case 2: We have executed trace1 and must now execute trace2
    } else if (this.larjKernel.diffusionKernel.trace === this.trace1) {
      this.larjKernel.diffusionKernel.trace = this.trace2;
      return this.trace2.continue();
    } else {
      throw 'This should be impossible';
    }
  };

  InterpolationTrace.prototype.complete = function(val) {
    this.trace1.complete(val);
    this.trace2.complete(val);
  };

  InterpolationTrace.prototype.isComplete = function() {
    return this.trace1.isComplete() && this.trace2.isComplete();
  };

  InterpolationTrace.prototype.upToAndIncluding = function(i) {
    var t1 = this.__upToAndIncluding(i, this.trace1);
    var t2 = this.__upToAndIncluding(i, this.trace2);
    return new InterpolationTrace(t1, t2, this.larjKernel, this.alpha);
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
//     pass 'proposalBoundary' to the diffusion kernel as well (along with
//     'exitFactor' and 'adRequired')
//   - In index.js, create 'LARJ_MH' and 'LARJ_HMC', have them do the right thing.
//     Make sure LARJ_HMC exposes 'adRequired' as a property.

  function LARJKernel(cont, oldTrace, options) {
    var options = util.mergeDefaults(options, {
      proposalBoundary: 0,
      exitFactor: 0,
      adRequired: false,
      annealingSteps: 0,
      jumpFreq: undefined   // Default to numDiscreteChoice/numAllChoices
    });

    assert(options.diffusionKernel, 'LARJ requires a diffusion kernel');

    this.cont = cont;
    this.oldTrace = oldTrace;

    this.proposalBoundary = options.proposalBoundary;
    this.exitFactor = options.exitFactor;
    this.adRequired = options.adRequired;

    this.annealingSteps = options.annealingSteps;
    this.jumpFreq = options.jumpFreq;
    this.diffusionKernel = options.diffusionKernel;
    this.currentAnnealingTrace = undefined;

    this.coroutine = env.coroutine;
    env.coroutine = this;
  };

  LARJKernel.prototype.run = function() {
    //
  };

  LARJKernel.prototype.sample = function() {
    // Forward to diffusion kernel
    return this.diffusionKernel.sample.apply(this.diffusionKernel, arguments);
  };

  LARJKernel.prototype.factor = function() {
    // Forward to diffusion kernel
    return this.diffusionKernel.factor.apply(this.diffusionKernel, arguments);
  };

  // This interacts with InterpolationTrace.continue to make it possible to execute
  //    both subtraces
  LARJKernel.prototype.exit = function() {
    // Case 1: We have finished executing trace1 and must now execute trace2
    if (this.diffusionKernel.trace === this.currentAnnealingTrace.trace1) {
      this.currentAnnealingTrace.continue();
    // Case 2: We have finished executing trace2 and can restore control to the
    //    diffusion kernel coroutine.
    } else if (this.diffusionKernel.trace === this.currentAnnealingTrace.trace2) {
      this.diffusionKernel.trace = this.currentAnnealingTrace;
      env.coroutine = this.diffusionKernel;
      this.diffusionKernel.exit.apply(this.diffusionKernel, arguments);
    } else {
      throw 'This should be impossible';
    }
  };

  LARJKernel.prototype.incrementalize = env.defaultCoroutine.incrementalize;

	return function(cont, oldTrace, options) {
    return new LARJKernel(cont, oldTrace, options).run();
	};
};


