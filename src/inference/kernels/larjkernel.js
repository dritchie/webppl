'use strict';

// TODO:
//   - Check consistency after running? (i.e. throw error if structure has changed,
//     by checking if any addresses were added/removed).
//     * Related: When MHKernel is in 'continuousOnly' mode, have it throw an error
//       if it couldn't find prevChoice (like what HMC does).

// Trace properties used by MH / HMC:
//  - score (read/write)
//  - numFactors (read/write)
//  - store (read)
//  - k (read)
//  - value (read/write)
//  - info (read/write)
//  - length (read)
//  - choices (read)
// Trace methods used by MH / HMC:
//  - upto
//  - choiceAtIndex
//  - saveContinuation
//  - findChoice
//  - addChoice
//  - complete
//  - isComplete
//  - fresh (HMC only)
//  - continue (HMC only?)
function InterpolationTrace(trace1, trace2, regenFrom) {
} 


// TODO:
//   - Jump proposals need to respect 'proposalBoundary', and we need to
//     pass 'proposalBoundary' to the diffusion kernel as well.
//   - Have a list of permitted diffusion kernels? (i.e. HMConly, MH with continuousOnly)

module.exports = function(env) {

	var kutils = require('./utils')(env);

	return function(cont, oldTrace, options) {

	};
};