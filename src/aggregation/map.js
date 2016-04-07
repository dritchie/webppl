'use strict';

var _ = require('underscore');
var util = require('../util');
var ad = require('../ad');
var Histogram = require('./histogram');

var MAP = function(retainSamples, adRequired) {
  this.max = { value: undefined, score: -Infinity };
  this.samples = [];
  this.retainSamples = retainSamples;
  this.adRequired = adRequired;
};

MAP.prototype.add = function(value, score, time) {
  if (this.adRequired) {
    value = ad.deepUntapify(value);
    score = ad.untapify(score);
  }
  if (this.retainSamples) {
    this.samples.push({ value: value, score: score, time: time });
  }
  if (score > this.max.score) {
    this.max.value = value;
    this.max.score = score;
  }
};

MAP.prototype.toERP = function() {
  var hist = new Histogram();
  hist.add(this.max.value);
  var erp = hist.toERP();
  if (this.retainSamples) {
    erp.samples = this.samples;
  }
  return erp;
};

module.exports = MAP;
