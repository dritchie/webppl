'use strict';

var ad = require('../../ad');
var util = require('../../util');
var Trace = require('../../trace');


module.exports = function(env) {

  // TODO:
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
    this.larjKernel.diffusionKernelObj = env.coroutine;
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

  // Called after continue() has finished
  // Make choices list refer to new objects
  // Ensure that structure has not changed
  InterpolationTrace.prototype.finish = function() {
    // Update choice list, ensure that every choice in choice list
    //    is present in at least one of the two subtraces.
    var addressMap = {};
    for (var i = 0; i < this.choices.length; i++) {
      var addr = this.choices[i].address;
      addressMap[addr] = true;
      if (this.trace1.findChoice(addr)) {
        this.choices[i] = this.trace1.findChoice(addr);
      } else if (this.trace2.findChoice(addr)) {
        this.choices[i] = this.trace2.findChoice(addr);
      } else {
        throw 'Illegal structure change detected for interpolation trace';
      }
    }
    // Ensure that every choice in the subtraces is present in the
    //    choice list
    for (var i = 0; i < this.trace1.choices.length; i++) {
      assert(addressMap[this.trace1.choices[i].address],
        'Illegal structure change detected for interpolation trace');
    }
    for (var i = 0; i < this.trace2.choices.length; i++) {
      assert(addressMap[this.trace2.choices[i].address],
        'Illegal structure change detected for interpolation trace');
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

  InterpolationTrace.prototype.setChoiceValue = function(address, val) {
    if (this.trace1.findChoice(address)) {
      this.trace1.setChoiceValue(address, val);
    }
    if (this.trace2.findChoice(address)) {
      this.trace2.setChoiceValue(address, val);
    }
  };


  // --------------------------------------------------------------------------


  // This is just a simple extension of the vanilla Trace class which lets the
  //    LARJ kernel steal back control of env.coroutine when continue() is called.
  // 'victimName' is the name of the kernel that has control stolen from it.

  function StealingTrace(wpplFn, s, k, a, stealingKernel, victimName) {
    Trace.call(this, wpplFn, s, k, a);
    this.stealingKernel = stealingKernel;
    this.victimName = victimName;
  }
  StealingTrace.prototype = Object.create(Trace.prototype);

  StealingTrace.prototype.fresh = function() {
    return new StealingTrace(this.wpplFn, this.initialStore, this.exitK, this.baseAddress,
      this.stealingKernel, this.victimName);
  };

  StealingTrace.fromTrace = function(trace, stealingKernel, victimName) {
    var t = new StealingTrace(trace.wpplFn, trace.initialStore, trace.exitK, trace.baseAddress,
      stealingKernel, victimName);
    t.copyFrom(trace);
    return t;
  };

  StealingTrace.prototype.toTrace = function() {
    var t = new Trace(this.wpplFn, this.initialStore, this.exitK, this.baseAddress);
    t.copyFrom(this);
    return t;
  };

  StealingTrace.prototype.continue = function() {
    this.stealingKernel[this.victimName] = env.coroutine;
    env.coroutine = this.stealingKernel;
    return Trace.prototype.continue.call(this);
  };


  // --------------------------------------------------------------------------


  function LARJKernel(cont, oldTrace, options) {
    var options = util.mergeDefaults(options, {
      proposalBoundary: 0,
      exitFactor: 0,
      adRequired: false,
      annealingSteps: 0,
      jumpFreq: undefined   // Default to numDiscreteChoice/numAllChoices
    });

    this.cont = cont;
    this.oldTrace = oldTrace;

    this.proposalBoundary = options.proposalBoundary;
    this.adRequired = options.adRequired;

    this.annealingSteps = options.annealingSteps;
    this.jumpFreq = options.jumpFreq;
    this.currentAnnealingTrace = undefined;

    assert(options.diffusionKernel, 'LARJ requires a diffusion kernel');
    assert(options.jumpKernel, 'LARJ requires a jump kernel');
    this.diffusionKernelFn = options.diffusionKernel;
    this.jumpKernelFn = options.jumpKernel;
    this.subKernelOpts = {
      proposalBoundary: options.proposalBoundary,
      exitFactor: options.exitFactor,
      adRequired: options.adRequired
    };

    this.coroutine = env.coroutine;
    env.coroutine = this;
  };

  LARJKernel.prototype.run = function() {
    var jumpProb = this.jumpFreq ||
      (this.numProposableJumpChoices(this.oldTrace) / this.numProposableChoices(this.oldTrace));
    if (Math.random() < jumpProb) {
      return this.jumpStep();
    } else {
      return this.diffusionStep();
    }
  };

  LARJKernel.prototype.sample = function() {
    if (this.currentAnnealingTrace === undefined) {
      // Forward to the jump kernel
      return this.jumpKernelObj.sample.apply(this.jumpKernelObj, arguments);
    } else {
      // Forward to diffusion kernel
      return this.diffusionKernelObj.sample.apply(this.diffusionKernelObj, arguments);
    }
  };

  LARJKernel.prototype.factor = function() {
    if (this.currentAnnealingTrace === undefined) {
      // Forward to the jump kernel
      return this.jumpKernelObj.factor.apply(this.jumpKernelObj, arguments);
    } else {
      // Forward to diffusion kernel
      return this.diffusionKernelObj.factor.apply(this.diffusionKernelObj, arguments);
    }
  };

  // This interacts with InterpolationTrace.continue to make it possible to execute
  //    both subtraces
  LARJKernel.prototype.exit = function() {
    if (this.currentAnnealingTrace === undefined) {
      // We have finished executing the initial jump
      // TODO: Incorporate annealing
      this.jumpKernelObj.trace = this.jumpKernelObj.trace.toTrace();  // StealingTrace -> Trace
      env.coroutine = this.jumpKernelObj;
      this.jumpKernelObj = undefined;
      return env.exit.apply(null, arguments);
    } else {
      // Case 1: We have finished executing trace1 and must now execute trace2
      if (this.diffusionKernelObj.trace === this.currentAnnealingTrace.trace1) {
        this.currentAnnealingTrace.continue();
      // Case 2: We have finished executing trace2 and can restore control to the
      //    diffusion kernel coroutine.
      } else if (this.diffusionKernelObj.trace === this.currentAnnealingTrace.trace2) {
        this.currentAnnealingTrace.finish();
        this.diffusionKernelObj.trace = this.currentAnnealingTrace;
        env.coroutine = this.diffusionKernelObj;
        this.diffusionKernelObj = undefined;
        return env.exit.apply(null, arguments);
      } else {
        throw 'This should be impossible';
      }
    }
  };

  LARJKernel.prototype.incrementalize = env.defaultCoroutine.incrementalize;

  LARJKernel.prototype.diffusionStep = function() {
    return this.diffusionKernelFn(this.cont, this.oldTrace, this.subKernelOpts);
  };

  LARJKernel.prototype.jumpStep = function() {
    var stealingTrace = StealingTrace.fromTrace(this.oldTrace, this, 'jumpKernelObj');
    return this.jumpKernelFn(this.cont, stealingTrace, this.subKernelOpts);
    // return this.jumpKernelFn(this.cont, this.oldTrace, this.subKernelOpts);
  };

  LARJKernel.prototype.proposableDiscreteErpIndices = function(trace) {
    return _.range(this.proposalBoundary, trace.length).filter(function(i) {
      return !trace.choices[i].erp.isContinuous;
    });
  };

  LARJKernel.prototype.numProposableChoices = function(trace) {
    return trace.length - this.proposalBoundary;
  };

  LARJKernel.prototype.numProposableJumpChoices = function(trace) {
    return this.proposableDiscreteErpIndices(trace).length;
  };

	return function(cont, oldTrace, options) {
    return new LARJKernel(cont, oldTrace, options).run();
	};
};


