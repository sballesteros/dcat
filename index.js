var http = require('http')
  , owner = require('./lib/owner')
  , cookie = require('cookie');

var Dpm = module.exports = function(rc, root){
  this.root = root || process.cwd();

  this.rc = rc;
};

['adduser','publish', 'install'].forEach(function(method){
  Dpm.prototype[method] = require('./lib/' + method);
});

Dpm.prototype.addOwner = owner.add;
Dpm.prototype.lsOwner = owner.ls;

/**
 * get an auth token
 */
Dpm.prototype.auth = function(callback){

  if('token' in this.rc){
    return callback(null, this.rc.token);
  }

  var data = JSON.stringify({name: this.rc.name, password: this.rc.password});

  var options = {
    port: 5984,
    hostname: '127.0.0.1',
    method: 'POST',
    path: '/_session',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data,'utf8')
    }
  };

  http.request(options, function(res){
    try {
      var token = cookie.parse(res.headers['set-cookie'][0])['AuthSession'];
    } catch(e){
      return callback(new Error('no cookie for auth: ' + e.message));
    }
    res.resume();

    this.rc.token = token;
    callback(null, token);
  }.bind(this)).end(data);

};
