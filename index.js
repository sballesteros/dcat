var http = require('http')
  , owner = require('./lib/owner')
  , cookie = require('cookie');

var Dpm = module.exports = function(rc, root){
  this.root = root || process.cwd();

  this.rc = rc;
};

['adduser','publish', 'install', 'request'].forEach(function(method){
  Dpm.prototype[method] = require('./lib/' + method);
});


Dpm.prototype.lsOwner = owner.ls;
Dpm.prototype.addOwner = owner.add;
Dpm.prototype.rmOwner = owner.rm;

/**
 * data: {dpkgName[@version]}
 */
Dpm.prototype.unpublish = function(dpkgId, callback){
  dpkgId = dpkgId.replace('@', '/');

  this.request('/unpublish/'+ dpkgId, callback);
};

