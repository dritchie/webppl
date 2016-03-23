'use strict';

var _ = require('underscore');
var assert = require('assert');
var erp = require('../../erp');
var util = require('../../util');
var ad = require('../../ad');

module.exports = function(env) {

  function MHKernel(cont, oldTrace, options) {
    var options = util.mergeDefaults(options, {
      proposalBoundary: 0,
      exitFactor: 0,
      permissive: false,
      discreteOnly: false,
      continuousOnly: false,
      adRequired: false
    });

    if (!options.permissive) {
      assert.notStrictEqual(oldTrace.score, -Infinity);
    }

    this.cont = cont;
    this.oldTrace = oldTrace;
    this.reused = {};

    this.proposalBoundary = options.proposalBoundary;
    this.exitFactor = options.exitFactor;
    this.discreteOnly = options.discreteOnly;
    this.continuousOnly = options.continuousOnly;
    this.adRequired = options.adRequired;

    this.coroutine = env.coroutine;
    env.coroutine = this;
  }

  MHKernel.prototype.run = function() {
    this.oldTrace.preKernelRun();

    this.regenFrom = this.sampleRegenChoice(this.oldTrace);
    if (this.regenFrom < 0) {
      return this.bail(true);
    }
    env.query.clear();

    var regen = this.oldTrace.choiceAtIndex(this.regenFrom);
    var erp = regen.erp;
    var proposalErp = erp.proposer || erp;
    var proposalParams = erp.proposer ? [regen.params, regen.val] : regen.params;
    var _val = proposalErp.sample(ad.untapify(proposalParams));
    var val = this.adRequired && proposalErp.isContinuous ? ad.tapify(_val) : _val;

    // Optimization: Bail early if same value is re-sampled.
    if (!proposalErp.isContinuous && regen.val === val) {
      return this.bail(true);
    }

    this.trace = this.oldTrace.upToAndIncluding(this.regenFrom);
    this.trace.setChoiceValue(regen.address, val);

    // Optimization: Bail early if probability went to zero
    if (ad.untapify(this.trace.score) === -Infinity) {
      return this.bail(false);
    }

    // Else, continue running program by running from the last choice in the trace
    // (This is pretty roundabout compared to just calling regen.k, but it is
    //    needed to make LARJ work).
    this.trace.saveContinuation(regen.store, function(s) {
      var lastChoice = this.trace.choiceAtIndex(this.trace.length - 1);
      return lastChoice.k(_.clone(lastChoice.store), lastChoice.val);
    }.bind(this));
    return this.trace.continue();
    // return regen.k(_.clone(regen.store), val);
  };

  MHKernel.prototype.factor = function(s, k, a, score) {
    this.trace.numFactors += 1;
    this.trace.score = ad.add(this.trace.score, score);
    // Optimization: Bail early if we know acceptProb will be zero.
    if (ad.untapify(this.trace.score) === -Infinity) {
      return this.bail(false);
    }
    if (this.trace.numFactors === this.exitFactor) {
      this.trace.saveContinuation(s, k);
      return this.earlyExit(s);
    }
    return k(s);
  };

  MHKernel.prototype.sample = function(s, k, a, erp, params) {
    var _val, val;
    var prevChoice = this.oldTrace.findChoice(a);

    if (prevChoice) {
      val = prevChoice.val; // Will be a tape if continuous.
      this.reused[a] = true;
    } else {
      _val = erp.sample(ad.untapify(params));
      val = this.adRequired && erp.isContinuous ? ad.tapify(_val) : _val;
    }

    this.trace.addChoice(erp, params, val, a, s, k);
    // Bail early if probability went to zero
    if (ad.untapify(this.trace.score) === -Infinity) {
      return this.bail(false);
    }
    return k(s, val);
  };

  MHKernel.prototype.bail = function(accept) {
    return env.exit(undefined, undefined, undefined, accept);
  };

  MHKernel.prototype.earlyExit = function(s) {
    return env.exit(s, undefined, true);
  };

  // IMPORTANT: This is never called directly. Only called via env.exit
  // (This is needed for LARJ to work correctly)
  MHKernel.prototype.exit = function(s, val, earlyExit, bailAccept) {
    if (bailAccept !== undefined) {
      return this.finish(this.oldTrace, bailAccept);
    } 
    if (!earlyExit) {
      if (val === env.query)
        val = _.extendOwn({}, this.oldTrace.value, env.query.getTable());
      this.trace.complete(val);
    } else {
      assert(!this.trace.isComplete());
    }
    var prob = this.acceptProb(this.trace, this.oldTrace);
    var accept = util.random() < prob;
    return this.finish(accept ? this.trace : this.oldTrace, accept);
  };

  // IMPORTANT: This is also never called directly. Only called from within
  //    this.exit.
  MHKernel.prototype.finish = function(trace, accepted) {
    assert(_.isBoolean(accepted));
    if (this.oldTrace.info) {
      var oldInfo = this.oldTrace.info;
      trace.info = {
        accepted: oldInfo.accepted + accepted,
        total: oldInfo.total + 1
      };
    }
    env.coroutine = this.coroutine;
    return this.cont(trace);
  };

  MHKernel.prototype.incrementalize = env.defaultCoroutine.incrementalize;

  MHKernel.prototype.proposableDiscreteErpIndices = function(trace) {
    return _.range(this.proposalBoundary, trace.length).filter(function(i) {
      return !trace.choices[i].erp.isContinuous;
    });
  };

  MHKernel.prototype.proposableContinuousErpIndices = function(trace) {
    return _.range(this.proposalBoundary, trace.length).filter(function(i) {
      return trace.choices[i].erp.isContinuous;
    });
  };

  MHKernel.prototype.numRegenChoices = function(trace) {
    if (this.discreteOnly) {
      return this.proposableDiscreteErpIndices(trace).length;
    }
    if (this.continuousOnly) {
      return this.proposableContinuousErpIndices(trace).length;
    }
    return trace.length - this.proposalBoundary;
  };

  MHKernel.prototype.sampleRegenChoice = function(trace) {
    if (this.discreteOnly) {
      return this.sampleRegenChoiceDiscrete(trace);
    }
    if (this.continuousOnly) {
      return this.sampleRegenChoiceContinuous(trace);
    }
    return this.sampleRegenChoiceAny(trace);
  };

  MHKernel.prototype.sampleRegenChoiceDiscrete = function(trace) {
    var indices = this.proposableDiscreteErpIndices(trace);
    return indices.length > 0 ? indices[Math.floor(util.random() * indices.length)] : -1;
  };

  MHKernel.prototype.sampleRegenChoiceContinuous = function(trace) {
    var indices = this.proposableContinuousErpIndices(trace);
    return indices.length > 0 ? indices[Math.floor(util.random() * indices.length)] : -1;
  };

  MHKernel.prototype.sampleRegenChoiceAny = function(trace) {
    var numChoices = trace.length - this.proposalBoundary;
    return numChoices > 0 ? this.proposalBoundary + Math.floor(util.random() * numChoices) : -1;
  };

  MHKernel.prototype.acceptProb = function(trace, oldTrace) {
    // assert.notStrictEqual(trace, undefined);
    // assert.notStrictEqual(oldTrace, undefined);
    // assert(_.isNumber(ad.untapify(trace.score)));
    // assert(_.isNumber(ad.untapify(oldTrace.score)));
    // assert(_.isNumber(this.regenFrom));
    // assert(_.isNumber(this.proposalBoundary));

    var fw = this.transitionProb(oldTrace, trace);
    var bw = this.transitionProb(trace, oldTrace);
    var p = Math.exp(ad.untapify(trace.score) - ad.untapify(oldTrace.score) + bw - fw);
    assert(!isNaN(p));
    return Math.min(1, p);
  };

  MHKernel.prototype.transitionProb = function(fromTrace, toTrace) {
    // Proposed to ERP.
    var proposalErp, proposalParams;
    var regenChoice = toTrace.choiceAtIndex(this.regenFrom);

    if (regenChoice.erp.proposer) {
      proposalErp = regenChoice.erp.proposer;
      proposalParams = [regenChoice.params, fromTrace.choiceAtIndex(this.regenFrom).val];
    } else {
      proposalErp = regenChoice.erp;
      proposalParams = regenChoice.params;
    }

    var score = ad.untapify(proposalErp.score(proposalParams, regenChoice.val));

    // Rest of the trace.
    score += util.sum(toTrace.choices.slice(this.regenFrom + 1).map(function(choice) {
      return this.reused.hasOwnProperty(choice.address) ? 0 : ad.untapify(choice.erp.score(choice.params, choice.val));
    }, this));

    score -= Math.log(this.numRegenChoices(fromTrace));
    assert(!isNaN(score));
    return score;
  };

  return function(cont, oldTrace, options) {
    return new MHKernel(cont, oldTrace, options).run();
  };

};
