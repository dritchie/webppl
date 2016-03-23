'use strict';

var assert = require('assert');
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

    this.rebuildMergedChoiceList();    
  }

  Object.defineProperty(InterpolationTrace.prototype, 'score', {
    get: function() {
      return ad.add(
        ad.mul(1-this.alpha, this.trace1.score),
        ad.mul(this.alpha, this.trace2.score)
      );
    }
  });

  Object.defineProperty(InterpolationTrace.prototype, 'length', {
    get: function() {
      return this.choices.length;
    }
  });

  InterpolationTrace.prototype.rebuildMergedChoiceList = function() {
    this.choices = [];
    var i = 0;
    var j = 0;
    // Simultaneously iterate over choices of both traces
    for (; i < this.trace1.choices.length && j < this.trace2.choices.length; i++, j++) {
      var c1 = this.trace1.choices[i];
      var c2 = this.trace2.choices[j];
      // If both traces have the same choice at this index, add it once
      if (c1.address === c2.address) {
        this.choices.push(c1);
      // If trace2 has choice c1 somewhere later on, add all choices
      //    from trace2 up to choice c1, then add c1 itself
      } else if (this.trace2.findChoice(c1.address)) {
        var c12 = this.trace2.findChoice(c1.address);
        for (; j < c12.index; j++)
          this.choices.push(this.trace2.choices[j]);
        this.choices.push(c1);
      // Analogous case to the above, but with trace1 and trace2 swapped
      } else if (this.trace1.findChoice(c2.address)) {
        var c21 = this.trace1.findChoice(c2.address);
        for (; i < c21.index; i++)
          this.choices.push(this.trace1.choices[i]);
        this.choices.push(c2);
      // If the choices at this index are unique to each trace, add them both
      } else {
        this.choices.push(c1);
        this.choices.push(c2);
      }
    }
    // Deal with any leftover choices (at most one of these loops will execute)
    for (; i < this.trace1.choices.length; i++) {
      this.choices.push(this.trace1.choices[i]);
    }
    for (; j < this.trace2.choices.length; j++) {
      this.choices.push(this.trace2.choices[j]);
    }
  };

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

  InterpolationTrace.prototype.debugPrint = function(header) {
    header = header || 'InterpolationTrace choices:';
    console.log(header);
    for (var i = 0; i < this.choices.length; i++) {
      console.log('  ' + this.choices[i].address);
    }
    this.trace1.debugPrint('trace1 choices:');
    this.trace2.debugPrint('trace2 choices:');
  };

  InterpolationTrace.prototype.saveContinuation = function(s, k) {
    this.trace1.saveContinuation(s, k);
    this.trace2.saveContinuation(s, k);
  };

  InterpolationTrace.prototype.preKernelRun = function() {
    // LARJ kernel assumes control
    this.larjKernel.diffusionKernelObj = env.coroutine;
    env.coroutine = this.larjKernel;
  };

  // This interacts with LARJKernel.exit to ensure that both subtraces
  //    are continued.
  InterpolationTrace.prototype.continue = function() {
    // Case 1: We have yet to execute the first trace
    if (this.larjKernel.diffusionKernelObj.trace === this) {
      // console.log('continue trace1');
      this.larjKernel.currentAnnealingTrace = this;
      this.larjKernel.diffusionKernelObj.trace = this.trace1;
      return this.trace1.continue();
    // Case 2: We have executed trace1 and must now execute trace2
    } else if (this.larjKernel.diffusionKernelObj.trace === this.trace1) {
      // console.log('continue trace2');
      this.larjKernel.diffusionKernelObj.trace = this.trace2;
      return this.trace2.continue();
    } else {
      throw 'LARJ diffusion kernel trace set to impossible value on InterpolationTrace.continue';
    }
  };

  // Called after continue() has finished
  InterpolationTrace.prototype.finish = function() {
    this.rebuildMergedChoiceList();
  };

  InterpolationTrace.prototype.hasSameStructure = function(otherTrace) {
    if (this === otherTrace) {
      return true;
    } else if (this.length !== otherTrace.length) {
      return false;
    } else {
      for (var i = 0; i < this.choices.length; i++) {
        if (this.choices[i].address !== otherTrace.choices[i].address) {
          return false;
        }
      }
      return true;
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

  StealingTrace.fromTrace = function(trace, stealingKernel, victimName) {
    var t = new StealingTrace(trace.wpplFn, trace.initialStore, trace.exitK, trace.baseAddress,
      stealingKernel, victimName);
    t.copyFrom(trace);
    return t;
  };

  StealingTrace.prototype.preKernelRun = function() {
    // Stealing kernel assumes control
    this.stealingKernel[this.victimName] = env.coroutine;
    env.coroutine = this.stealingKernel;
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

    assert(options.annealingSteps === 0 || options.annealingSteps >= 2,
      'LARJ needs to do at least two annealing steps (if it does any)');
    this.annealingSteps = options.annealingSteps;
    this.jumpFreq = options.jumpFreq;

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
    this.oldTrace.preKernelRun();

    var jumpProb = this.jumpFreq ||
      (this.numProposableJumpChoices(this.oldTrace) / this.numProposableChoices(this.oldTrace));
    if (util.random() < jumpProb) {
      return this.jumpStep();
    } else {
      return this.diffusionStep();
    }
  };

  LARJKernel.prototype.sample = function() {
    if (this.diffusionKernelObj === undefined) {
      // Forward to the jump kernel
      return this.jumpKernelObj.sample.apply(this.jumpKernelObj, arguments);
    } else {
      // Forward to diffusion kernel
      return this.diffusionKernelObj.sample.apply(this.diffusionKernelObj, arguments);
    }
  };

  LARJKernel.prototype.factor = function() {
    if (this.diffusionKernelObj === undefined) {
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
    if (this.diffusionKernelObj === undefined) {
      // console.log('jump initial exit');
      // We have finished executing the initial jump
      return this.jumpContinuation.apply(null, arguments);
    } else {
      // Case 1: The diffusion kernel exited before ever creating a new trace, or it
      //    exited with a zero-probability trace. This will be rejected, so we
      //    immediately restore control to the diffusion kernel and let it exit.
      if (this.diffusionKernelObj.trace === undefined ||
        ad.untapify(this.diffusionKernelObj.trace.score) === -Infinity) {
        // console.log('annealing bail exit');
        return this.diffusionExit.apply(this, arguments);
      // Case 2: We have finished executing trace1 and must now execute trace2
      } else if (this.diffusionKernelObj.trace === this.currentAnnealingTrace.trace1) {
        // console.log('annealing trace1 exit');
        return this.currentAnnealingTrace.continue();
      // Case 3: We have finished executing trace2 and can restore control to the
      //    diffusion kernel coroutine.
      } else if (this.diffusionKernelObj.trace === this.currentAnnealingTrace.trace2) {
        // console.log('annealing trace2 exit');
        this.currentAnnealingTrace.finish();  // Finalize
        this.diffusionKernelObj.trace = this.currentAnnealingTrace;
        this.currentAnnealingTrace = undefined;
        return this.diffusionExit.apply(this, arguments);
      } else {
        throw 'LARJ diffusion kernel trace set to impossible value on LARJKernel.exit';
      }
    }
  };

  LARJKernel.prototype.incrementalize = env.defaultCoroutine.incrementalize;

  LARJKernel.prototype.diffusionExit = function() {
    env.coroutine = this.diffusionKernelObj;
    this.diffusionKernelObj = undefined;
    return env.exit.apply(null, arguments);
  };

  LARJKernel.prototype.jumpExit = function() {
    env.coroutine = this.jumpKernelObj;
    this.jumpKernelObj = undefined;
    return env.exit.apply(null, arguments);
  };

  LARJKernel.prototype.diffusionStep = function() {
    // console.log('diffusionStep');
    env.coroutine = this.coroutine;   // So nested inference works
    return this.diffusionKernelFn(this.cont, this.oldTrace, this.subKernelOpts);
  };

  LARJKernel.prototype.jumpStep = function() {
    // console.log('============================================');
    // console.log('jumpStep');
    // jumpContinuation receives exit arguments (there may be more than just
    //    s and val)
    this.jumpContinuation = function(s, val) {
      // console.log('jumpContinuation');
      this.jumpContinuation = undefined;

      // Convert jumpKernelObj.oldTrace from a StealingTrace back into a regular
      //    Trace, so that StealingTraces don't escape LARJKernel code
      this.jumpKernelObj.oldTrace = this.oldTrace;

      // If 'trace' isn't defined on the jump kernel, then we assume that the jump
      //    kernel bailed out early before creating a new trace.
      // In this case, or if 'trace' exists but has zero probability, we know there's
      //    no point to annealing and we can invoke final exit immediately
      if (this.jumpKernelObj.trace === undefined ||
        ad.untapify(this.jumpKernelObj.trace.score) === -Infinity) {
        // console.log('jump bail exit');
        return this.jumpExit.apply(this, arguments);
      }

      var newTrace = this.jumpKernelObj.trace;

      // Do annealing (if annealing steps were requested and we have some continuous choices)
      var nc1 = this.numProposableDiffusionChoices(this.oldTrace);
      var nc2 = this.numProposableDiffusionChoices(newTrace);
      if (this.annealingSteps > 0 && nc1 + nc2 > 0) {
        // Need to complete the trace before we build proposals off of it (otherwise the
        //    'undefined' return value might persist through the whole annealing sequence)
        // We only do this here because the other control paths immediately call jumpExit,
        //    which itself invokes complete (via jumpKernelObj.exit).
        newTrace.complete(val);
        // console.log('begin annealing');
        var lerpTrace = new InterpolationTrace(this.oldTrace, newTrace, this);
        // We assume that jumpKernelObj provides a transitionProb(oldTrace, newTrace) method
        var fw = this.jumpKernelObj.transitionProb(lerpTrace.trace1, lerpTrace.trace2);
        var annealingLpRatio = 0;
        return util.cpsLoop(
          // number of loop iterations
          this.annealingSteps,
          // loop body function
          function(i, k) {
            // console.log('----------------------------');
            lerpTrace.alpha = i / (this.annealingSteps - 1);
            annealingLpRatio += ad.untapify(lerpTrace.score);
            return this.diffusionKernelFn(function(newLerpTrace) {
              assert(newLerpTrace.hasSameStructure(lerpTrace),
                'LARJ annealing: Illegal structure change detected ');
              lerpTrace = newLerpTrace;
              annealingLpRatio -= ad.untapify(lerpTrace.score);
              return k();
            }.bind(this), lerpTrace, this.subKernelOpts);
          }.bind(this),
          // final continuation when loop is finished
          function() {
            // Compute final LARJ acceptance probability, return
            var bw = this.jumpKernelObj.transitionProb(lerpTrace.trace2, lerpTrace.trace1);
            var newTrace = lerpTrace.trace2;
            var acceptProb =
              ad.untapify(newTrace.score)
              - ad.untapify(this.oldTrace.score)
              + bw - fw + annealingLpRatio;
            acceptProb = Math.min(1, Math.exp(acceptProb));
            assert(!isNaN(acceptProb));
            var accept = util.random() < acceptProb;
            env.coroutine = this.coroutine;
            // console.log('jump post-annealing final exit');
            return this.cont(accept ? newTrace : this.oldTrace);
          }.bind(this)
        );
      } else {
        // No annealing requested/possible, go ahead and invoke final exit
        // console.log('jump no annealing final exit');
        return this.jumpExit.apply(this, arguments);
      }
    }.bind(this);

    var stealingTrace = StealingTrace.fromTrace(this.oldTrace, this, 'jumpKernelObj');
    env.coroutine = this.coroutine;   // So nested inference works
    return this.jumpKernelFn(this.cont, stealingTrace, this.subKernelOpts);
    // return this.jumpKernelFn(this.cont, this.oldTrace, this.subKernelOpts);
  };

  LARJKernel.prototype.numProposableChoices = function(trace) {
    return trace.length - this.proposalBoundary;
  };

  LARJKernel.prototype.numProposableJumpChoices = function(trace) {
    return this.proposableDiscreteErpIndices(trace).length;
  };

  LARJKernel.prototype.numProposableDiffusionChoices = function(trace) {
    return this.proposableContinuousErpIndices(trace).length;
  };

  LARJKernel.prototype.proposableDiscreteErpIndices = function(trace) {
    return _.range(this.proposalBoundary, trace.length).filter(function(i) {
      return !trace.choices[i].erp.isContinuous;
    });
  };

  LARJKernel.prototype.proposableContinuousErpIndices = function(trace) {
    return _.range(this.proposalBoundary, trace.length).filter(function(i) {
      return trace.choices[i].erp.isContinuous;
    });
  };

	return function(cont, oldTrace, options) {
    return new LARJKernel(cont, oldTrace, options).run();
	};
};


