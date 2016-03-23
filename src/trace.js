'use strict';

var _ = require('underscore');
var assert = require('assert');
var isErp = require('./erp').isErp;
var ad = require('./ad');

function Trace(wpplFn, s, k, a) {
  // The program we're doing inference in, and the store, continuation
  // and address required to run it.
  this.wpplFn = wpplFn;
  this.initialStore = s;
  this.exitK = k; // env.exit
  this.baseAddress = a;

  this.choices = [];
  this.addressMap = {}; // Maps addresses => choices.

  // ** These are the ONLY publically-accessible read/write properties **
  this.score = 0;
  this.numFactors = 0; // The number of factors encountered so far.

  // this.checkConsistency();
};

// Length of the trace is a read-only property which just returns choices.length
Object.defineProperty(Trace.prototype, 'length', {
  get: function() {
    return this.choices.length;
  }
});

Trace.prototype.fresh = function() {
  // Create a new trace using wpplFn etc. from this Trace.
  return new Trace(this.wpplFn, this.initialStore, this.exitK, this.baseAddress);
};

Trace.prototype.choiceAtIndex = function(index) {
  return this.choices[index];
};

Trace.prototype.findChoice = function(address) {
  return this.addressMap[address];
};

// MCMC Kernels call this right before running
// This doesn't do anything, but Trace subclasses might do something.
Trace.prototype.preKernelRun = function() {};

Trace.prototype.saveContinuation = function(s, k) {
  this.store = s;
  this.k = k;
  // this.checkConsistency();
};

Trace.prototype.continue = function() {
  // If saveContinuation has been called continue, otherwise run from
  // beginning.
  if (this.k && this.store) {
    return this.k(this.store);
  } else {
    return this.wpplFn(_.clone(this.initialStore), this.exitK, this.baseAddress);
  }
};

Trace.prototype.addChoice = function(erp, params, val, address, store, continuation) {
  // Called at sample statements.
  // Adds the choice to the DB and updates current score.

  // assert(isErp(erp));
  // assert(_.isUndefined(params) || _.isArray(params));
  // assert(_.isString(address));
  // assert(_.isObject(store));
  // assert(_.isFunction(continuation));

  var choice = {
    k: continuation,
    address: address,
    erp: erp,
    params: params,
    // Record the score without adding the choiceScore. This is the score we'll
    // need if we regen from this choice.
    score: this.score,
    val: val,
    store: _.clone(store),
    numFactors: this.numFactors,
    index: this.length
  };

  this.choices.push(choice);
  this.addressMap[address] = choice;
  this.score = ad.add(this.score, erp.score(params, val));
  // this.checkConsistency();
};

// Used by MH proposals
// Had to introduce this abstraction to make LARJ work
Trace.prototype.setChoiceValue = function(address, val) {
  var choice = this.findChoice(address);
  assert(choice !== undefined);

  var newchoice = {
    k: choice.k,
    address: choice.address,
    erp: choice.erp,
    params: choice.params,
    score: choice.score,
    val: val, // new val
    store: _.clone(choice.store),
    numFactors: choice.numFactors,
    index: choice.index
  };
  this.choices[newchoice.index] = newchoice;
  this.addressMap[newchoice.address] = newchoice;

  // Works since choice.score is the trace score *before* adding the choice
  var choiceScore = choice.erp.score(newchoice.params, val);
  this.score = ad.add(newchoice.score, choiceScore);
};

Trace.prototype.complete = function(value) {
  // Called at coroutine exit.
  assert.strictEqual(this.value, undefined);
  this.value = value;
  // Ensure any attempt to continue a completed trace fails in an obvious way.
  this.k = this.store = undefined;
};

Trace.prototype.isComplete = function() {
  return this.k === undefined && this.store === undefined;
};

Trace.prototype.upto = function(i) {
  // We never take all choices as we don't include the choice we're regenerating
  // from.
  assert(i < this.length);

  var t = this.fresh();
  t.choices = this.choices.slice(0, i);
  t.choices.forEach(function(choice) { t.addressMap[choice.address] = choice; });
  t.score = this.choices[i].score;
  t.numFactors = this.choices[i].numFactors;
  // t.checkConsistency();
  return t;
};

// Also for MH proposals
Trace.prototype.upToAndIncluding = function(i) {
  var t = this.upto(i);
  var c = this.choices[i];
  t.addChoice(c.erp, c.params, c.val, c.address, c.store, c.k);
  return t;
};

Trace.prototype.copyFrom = function(other) {
  this.choices = other.choices.slice(0);
  this.addressMap = _.clone(other.addressMap);
  this.score = other.score;
  this.k = other.k;
  this.store = _.clone(other.store);
  this.baseAddress = other.baseAddress;
  this.value = other.value;
  this.numFactors = other.numFactors;
  // this.checkConsistency();
};

Trace.prototype.copy = function() {
  var t = this.fresh();
  t.copyFrom(this);
  return t;
};

Trace.prototype.debugPrint = function(header) {
  header = header || 'trace choices:';
  console.log(header);
  for (var i = 0; i < this.choices.length; i++) {
    console.log('  ' + this.choices[i].address, this.choices[i].val);
  }
}

Trace.prototype.checkConsistency = function() {
  assert(_.isFunction(this.wpplFn));
  assert(_.isFunction(this.exitK));
  assert(this.initialStore);
  assert(this.baseAddress);
  assert(this.k && this.store || !this.k && !this.store);
  assert(_.keys(this.addressMap).length === this.length);
  this.choices.forEach(function(choice) {
    assert(_.has(this.addressMap, choice.address));
  }, this);
  assert(this.value === undefined || (this.k === undefined && this.store === undefined));
};

module.exports = Trace;
