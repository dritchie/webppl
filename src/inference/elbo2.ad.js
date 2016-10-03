'use strict';

var _ = require('underscore');
var assert = require('assert');
var util = require('../util');
var ad = require('../ad');
var paramStruct = require('../paramStruct');
var guide = require('../guide');

module.exports = function(env) {

  function ELBO2(wpplFn, s, a, options, state, params, step, cont) {
    this.opts = util.mergeDefaults(options, {
      samples: 1,
      avgBaselines: false,
      avgBaselineDecay: 0.9,
      // Weight all factors in the LR term by log p/q.
      naiveLR: false,
      // Write a DOT file representation of first graph to disk.
      dumpGraph: false,
      // Use local weight of 1 (* multiplier) for sample and factor
      // nodes.
      debugWeights: false
    });

    // The current values of all initialized parameters.
    // (Scalars/tensors, not their AD nodes.)
    this.params = params;

    this.step = step;
    this.state = state;
    this.cont = cont;

    this.wpplFn = wpplFn;
    this.s = s;
    this.a = a;

    // Initialize mapData state.
    this.mapDataStack = [{multiplier: 1}];
    this.mapDataIx = {};

    if (!_.has(this.state, 'baselines')) {
      this.state.baselines = {};
    }
    this.baselineUpdates = {};

    this.coroutine = env.coroutine;
    env.coroutine = this;
  }

  function top(stack) {
    return stack[stack.length - 1];
  }

  // Build a graph to (coarsely) track dependency information so we
  // can perform *some* Rao-Blackwellization. This simple approach
  // builds a graph that represents:

  // 1. How p & q factorize.
  // 2. The conditional independence information from mapData.

  // This is used when building the AD graph to remove some
  // unnecessary terms from the weighting applied to each "grad logq"
  // factor in the LR part of the objective. This improves on the
  // naive implementation which weights each factor by logq - logp of
  // the full execution.

  // The graph is built as the program executes, then dependencies are
  // propagated by a separate pass. After this pass, a node's "deps"
  // property contains all the factors that need to be included in the
  // weighting of the corresponding grad logq factor.

  var nodeid = 0;

  function RootNode() {
    this.id = nodeid++;
    this.parents = [];
    this.weight = 0;
  }

  // TODO: This is probably too verbose for general use. Either remove
  // or hide behind a flag?
  function dumpDistAndVal(dist, x) {
    console.log('------------------------------');
    console.log(dist.meta.name);
    var _x = ad.value(x);
    console.log(_.isNumber(_x) ? _x : JSON.stringify(_x.toFlatArray()));
    console.log('------------------------------');
    _.each(dist.params, function(val, name) {
      console.log(name);
      console.log('------------------------------');
      var _val = ad.value(val);
      console.log(_.isNumber(_val) ? _val : JSON.stringify(_val.toFlatArray()));
      console.log('------------------------------');
    });
  }

  function SampleNode(parent, logp, logq, reparam, address, targetDist, guideDist, value, multiplier, debug) {
    this.id = nodeid++;
    var _logp = ad.value(logp);
    var _logq = ad.value(logq);
    // TODO: There's no reason these numerical checks need to be
    // smushed together with the node constructor.
    if (!isFinite(_logp)) {
      console.log('Address: ' + address);
      dumpDistAndVal(targetDist, value);
      throw new Error('SampleNode: logp is not finite.');
    }
    if (!isFinite(_logq)) {
      console.log('Address: ' + address);
      dumpDistAndVal(guideDist, value);
      throw new Error('SampleNode: logq is not finite.');
    }
    this.parents = [parent];
    this.logp = logp;
    this.logq = logq;
    this.weight = debug ? multiplier : _logq - _logp;
    this.reparam = reparam;
    this.address = address;
    // Debug info.
    this.targetDist = targetDist;
    this.multiplier = multiplier;
  }

  SampleNode.prototype.label = function() {
    return [
      this.targetDist.meta.name + '(' + this.id + ')',
      'w=' + this.weight,
      'm=' + this.multiplier
    ].join('\\n');
  };

  function FactorNode(parent, score, multiplier, debug) {
    this.id = nodeid++;
    var _score = ad.value(score);
    if (!isFinite(_score)) {
      throw new Error('FactorNode: score is not finite.');
    }
    this.parents = [parent];
    this.score = score;
    this.weight = debug ? multiplier : -_score;
    // Debug info.
    this.multiplier = multiplier;
  }

  FactorNode.prototype.label = function() {
    return [
      'Factor' + '(' + this.id + ')',
      'w=' + this.weight,
      'm=' + this.multiplier
    ].join('\\n');
  };

  // Created when entering mapData.
  function SplitNode(parent, batchSize, joinNode) {
    this.id = nodeid++;
    this.parents = [parent];
    this.batchSize = batchSize;
    this.joinNode = joinNode;
    this.weight = 0;
  }

  // Created when leaving mapData.
  function JoinNode() {
    this.id = nodeid++;
    this.parents = [];
    this.weight = 0;
  }

  function propagateWeights(nodes) {
    // Note that this modifies the weights of graph in-place.
    var i = nodes.length;
    while(--i) {
      var node = nodes[i];
      if (node instanceof SplitNode) {
        // Here we account for the fact we've added the score that
        // accumulated after this mapData once for every execution of
        // the observation function
        node.weight -= (node.batchSize - 1) * node.joinNode.weight;
      }
      node.parents.forEach(function(parent) {
        parent.weight += node.weight;
      });
    }
  };

  var edge = function(parent, child) {
    return '  ' + parent.id + ' -> ' + child.id + ';';
  };

  var shape = function(node, shape) {
    return '  ' + node.id + ' [shape = "' + shape + '"]';
  };

  var label = function(node) {
    return '  ' + node.id + ' [label = "' + node.label() + '"]';
  };

  function generateDot(nodes) {
    var edges = [];
    var append = function(x) { edges.push(x); };
    nodes.forEach(function(node) {
      if (node instanceof FactorNode) {
        append(shape(node, 'box'));
      }
      if (node instanceof RootNode ||
          node instanceof JoinNode ||
          node instanceof SplitNode) {
        append(shape(node, 'point'));
      }
      if (node.label) {
        append(label(node));
      }
      node.parents.forEach(function(parent) {
        append(edge(parent, node));
      });
    });
    return 'digraph {\n' + edges.join('\n') + '\n}\n';
  };

  ELBO2.prototype = {

    run: function() {

      var elbo = 0;
      var grad = {};

      return util.cpsLoop(
        this.opts.samples,

        // Loop body.
        function(i, next) {
          this.iter = i;
          return this.estimateGradient(function(g, elbo_i) {
            paramStruct.addEq(grad, g); // Accumulate gradient estimates.
            elbo += elbo_i;
            return next();
          });
        }.bind(this),

        // Loop continuation.
        function() {
          paramStruct.divEq(grad, this.opts.samples);
          elbo /= this.opts.samples;
          this.updateBaselines();
          env.coroutine = this.coroutine;
          return this.cont(grad, elbo);
        }.bind(this));

    },

    // Compute a single sample estimate of the gradient.

    estimateGradient: function(cont) {
      // paramsSeen tracks the AD nodes of all parameters seen during
      // a single execution. These are the parameters for which
      // gradients will be computed.
      this.paramsSeen = {};

      // This tracks nodes as we encounter them which saves doing a
      // topological sort later on.
      this.nodes = [];

      var root = new RootNode();
      this.prevNode = root; // prevNode becomes the parent of the next node.
      this.nodes.push(root);

      return this.wpplFn(_.clone(this.s), function() {

        propagateWeights(this.nodes);

        if (this.step === 0 && this.iter === 0 && this.opts.dumpGraph) {
          // To vizualize with Graphviz use:
          // dot -Tpng -O deps.dot
          var dot = generateDot(this.nodes);
          var fs = require('fs');
          fs.writeFileSync('deps.dot', dot);
        }

        var ret = this.buildObjective();

        if (ad.isLifted(ret.objective)) { // Handle programs with zero random choices.
          ret.objective.backprop();
        }

        var grads = _.mapObject(this.paramsSeen, function(params) {
          return params.map(ad.derivative);
        });

        return cont(grads, ret.elbo);

      }.bind(this), this.a);

    },

    buildObjective: function() {
      'use ad';
      var naiveLR = this.opts.naiveLR;
      var rootNode = this.nodes[0];
      assert.ok(rootNode instanceof RootNode);
      assert.ok(_.isNumber(rootNode.weight));

      var objective = this.nodes.reduce(function(acc, node) {
        if (node instanceof SampleNode && node.reparam) {
          return acc + (node.logq - node.logp);
        } else if (node instanceof SampleNode) {
          assert.ok(!node.param);
          var weight = naiveLR ? rootNode.weight : node.weight;
          assert.ok(_.isNumber(weight));
          var b = this.computeBaseline(node.address, weight);
          return acc + ((node.logq * (weight - b)) - node.logp);
        } else if (node instanceof FactorNode) {
          return acc - node.score;
        } else {
          return acc;
        }
      }.bind(this), 0);
      var elbo = -rootNode.weight;
      return {objective: objective, elbo: elbo};
    },

    computeBaseline: function(address, weight) {
      if (!this.opts.avgBaselines) {
        return 0;
      }

      var baselines = this.state.baselines;
      var baselineUpdates = this.baselineUpdates;

      // Accumulate the mean of the weights for each factor across
      // all samples taken this step. These are incorporated into
      // the running average once all samples have been taken.
      // Note that each factor is not necessarily encountered the
      // same number of times.

      if (!_.has(baselineUpdates, address)) {
        baselineUpdates[address] = {n: 1, mean: weight};
      } else {
        var prev = baselineUpdates[address];
        var n = prev.n + 1;
        var mean = (prev.n * prev.mean + weight) / n;
        baselineUpdates[address].n = n;
        baselineUpdates[address].mean = mean;
      }

      // During the first step we'd like to use the weight as the
      // baseline. The hope is that this strategy might avoid very
      // large gradients on the first step. If the initial baseline
      // was zero, these large gradients may cause optimization
      // methods with adaptive step sizes to reduce the step size (for
      // associated parameters) more than will be necessary once the
      // baseline takes effect. This might slow the initial phase of
      // optimization. However, using exactly the weight would cause
      // the gradient to be zero which in turn would trigger a warning
      // from Optimize. To avoid this we scale the weight and use that
      // as the initial baseline.

      return _.has(baselines, address) ? baselines[address] : weight * .99;
    },

    updateBaselines: function() {
      var decay = this.opts.avgBaselineDecay;
      var baselines = this.state.baselines;
      // Note that this leaves untouched the estimate of the average
      // weight for any factors not seen during this step.
      _.each(this.baselineUpdates, function(obj, address) {
        baselines[address] = _.has(baselines, address) ?
          decay * baselines[address] + (1 - decay) * obj.mean :
          obj.mean;
      }, this);
    },

    sample: function(s, k, a, dist, options) {
      options = options || {};

      var guideDist;
      if (options.guide) {
        guideDist = options.guide;
      } else {
        guideDist = guide.independent(dist, a, env);
        if (this.step === 0 &&
            this.opts.verbose &&
            !this.mfWarningIssued) {
          this.mfWarningIssued = true;
          console.log('ELBO: Defaulting to mean-field for one or more choices.');
        }
      }

      var ret = this.sampleGuide(guideDist, options);
      var val = ret.val;

      var m = top(this.mapDataStack).multiplier;
      var logp = ad.scalar.mul(m, dist.score(val));
      var logq = ad.scalar.mul(m, ret.logq);

      var node = new SampleNode(
        this.prevNode, logp, logq,
        ret.reparam, a, dist, guideDist, val, m, this.opts.debugWeights);

      this.prevNode = node;
      this.nodes.push(node);

      return k(s, val);
    },

    sampleGuide: function(dist, options) {
      var val, reparam;

      if ((!_.has(options, 'reparam') || options.reparam) &&
          dist.base && dist.transform) {
        // Use the reparameterization trick.
        var baseDist = dist.base();
        var z = baseDist.sample();
        val = dist.transform(z);
        reparam = true;
      } else if (options.reparam && !(dist.base && dist.transform)) {
        throw dist + ' does not support reparameterization.';
      } else {
        val = dist.sample();
        reparam = false;
      }

      var logq = dist.score(val);
      return {val: val, logq: logq, reparam: reparam};
    },

    factor: function(s, k, a, score, name) {
      var m = top(this.mapDataStack).multiplier;
      var node = new FactorNode(
        this.prevNode, ad.scalar.mul(m, score), m, this.opts.debugWeights);
      this.prevNode = node;
      this.nodes.push(node);
      return k(s);
    },

    mapDataFetch: function(data, batchSize, address) {

      // Compute batch indices.

      var ix;
      if (_.has(this.mapDataIx, address)) {
        ix = this.mapDataIx[address];
      } else {
        if (batchSize === data.length) {
          // Use all the data, in order.
          ix = null;
        } else {
          ix = _.times(batchSize, function() {
            return Math.floor(util.random() * data.length);
          });
        }
        // Store batch indices so that we can use the same mini-batch
        // across samples.
        this.mapDataIx[address] = ix;
      }

      if (batchSize > 0) {
        // Compute the multiplier required to account for the fact we're
        // only looking at a subset of the data.
        var thisM = data.length / batchSize;
        var prevM = top(this.mapDataStack).multiplier;
        var multiplier = thisM * prevM;

        var joinNode = new JoinNode();
        var splitNode = new SplitNode(this.prevNode, batchSize, joinNode);
        this.nodes.push(splitNode);

        this.mapDataStack.push({
          splitNode: splitNode,
          joinNode: joinNode,
          multiplier: multiplier
        });
      } else {
        // Signal to mapDataFinal that the batch was empty.
        this.mapDataStack.push(null);
      }

      return ix;
    },

    mapDataEnter: function() {
      // For every observation function, set the current node back to
      // the split node.
      this.prevNode = top(this.mapDataStack).splitNode;
    },

    mapDataLeave: function() {
      // Hook-up the join node to the last node on this branch. If
      // there were no sample/factor nodes created in the observation
      // function then this connects the join node directly to the
      // split node. The correction applied to split nodes in
      // propagateWeights requires such edges to be present for
      // correctness.
      top(this.mapDataStack).joinNode.parents.push(this.prevNode);
    },

    mapDataFinal: function(address) {
      var top = this.mapDataStack.pop();
      if (top !== null) {
        var joinNode = top.joinNode;
        this.prevNode = joinNode;
        this.nodes.push(joinNode);
      }
    }

  };

  return function() {
    var coroutine = Object.create(ELBO2.prototype);
    ELBO2.apply(coroutine, arguments);
    return coroutine.run();
  };

};
