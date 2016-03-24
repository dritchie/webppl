'use strict';

var _ = require('underscore');
var ad = require('ad.js')({ mode: 'r', noHigher: true });

ad.isTape = function(obj) {
  return _.has(obj, 'primal');
};

// Recursively untapify objects. ad.js already does this for arrays,
// here we extend that to other objects.
ad.deepUntapify = function(x) {
  if (_.isObject(x) && !_.isArray(x) && !ad.isTape(x)) {
  	var proto = Object.getPrototypeOf(x);
  	var xx = _.mapObject(x, ad.deepUntapify);
  	Object.setPrototypeOf(xx, proto);
  	return xx;
    // return _.mapObject(x, ad.deepUntapify);
  } else {
    return ad.untapify(x);
  }
};

module.exports = ad;
