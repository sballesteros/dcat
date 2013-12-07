var http = require('http')
  , cookie = require('cookie');

var Dpm = module.exports = function(rc, root){
  this.root = root || process.cwd();

  this.rc = rc;
};

['adduser', 'addToMaintainer','publish'].forEach(function(method){
  Dpm.prototype[method] = require('./lib/' + method);
});

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

var dpm = new Dpm(require('rc')('dpm', {port: 5984, hostname: '127.0.0.1'}), 'test/data');
dpm.auth(function(err, token){ 

  dpm.publish(token, function(err, body){
    if(err) console.log(err.message, err.code);
    if(body) console.log(body);
  });

});

//dpm.adduser(function(err, body){
//  if(err) console.log(err.message, err.code);
//  if(body) console.log(body);
//})

//dpm.addToMaintainer({granter: 'seb', granted: 'seb', dpkgName: 'mydpkg', _id: 'mydpkg@0.0.0' }, function(err, body){
//  if(err) console.log(err.message, err.code);
//  if(body) console.log(body);
//})
