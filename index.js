var http = require('http')
  , crypto = require('crypto')
  , querystring = require('querystring')
  , cookie = require('cookie')
  , EventEmitter = require('events').EventEmitter
  , util = require('util')
  , request = require('request')
  , path = require('path')
  , mime = require('mime')
  , async = require('async')
  , fs = require('fs')
  , publish = require('./lib/publish');


var Dpm = module.exports = function(rc, root){
  EventEmitter.call(this);

  this.root = root || process.cwd();

  this.rc = rc;
};

util.inherits(Dpm, EventEmitter);

Dpm.prototype.publish = publish;


Dpm.prototype.url = function(path, queryObj){
  return 'http://' + this.rc.hostname + ':' + this.rc.port + path + ( (queryObj) ? '?' + querystring.stringify(queryObj): '');
}

Dpm.prototype.auth = function(){
  return {user: this.rc.name, pass: this.rc.password};
}

Dpm.prototype.log = function(methodCode, reqUrl){
  this.emit('log', 'dpm'.grey + ' http '.green + methodCode.toString().magenta + ' ' + reqUrl.replace(':80/', '/'));
};


Dpm.prototype.lsOwner = function(dpgkName, callback){

  var rurl = this.url('/owner/ls/' + dpkgName);
  this.log('GET', rurl);

  request(rurl, function(err, res, body){
    if(err) return callback(err);
    this.log(res.statusCode, rurl);

    if(res.statusCode >= 400){
      var err = new Error(body);
      err.code = res.statusCode;
      callback(err);
    }
    
    callback(null, JSON.parse(body));
  }.bind(this));    
  
};

/**
 * data: {username, dpkgName}
 */
Dpm.prototype.addOwner = function(data, callback){
  var rurl = this.url('/owner/add');
  this.log('POST', rurl);
  request.post({
    url: rurl,
    auth: this.auth(),
    json: data
  }, function(err, res, body){
    if(err) return callback(err);
    this.log(res.statusCode, rurl);
    if(res.statusCode >= 400){
      var err = new Error(JSON.stringify(body));
      err.code = res.statusCode;
      return callback(err);
    }
    callback(null, body);
  }.bind(this));
};

/**
 * data: {username, dpkgName}
 */
Dpm.prototype.rmOwner = function(data, callback){
  var rurl = this.url('/owner/rm');
  this.log('POST', rurl);
  request.post({
    url: rurl,
    auth: this.auth(),
    json: data
  }, function(err, res, body){
    if(err) return callback(err);
    this.log(res.statusCode, rurl);
    if(res.statusCode >= 400){
      var err = new Error(JSON.stringify(body));
      err.code = res.statusCode;
      return callback(err);
    }
    callback(null, body);
  }.bind(this));
};


/**
 * data: {dpkgName[@version]}
 */
Dpm.prototype.unpublish = function(dpkgId, callback){
  dpkgId = dpkgId.replace('@', '/');

  var rurl = this.url('/'+ dpkgId);
  this.log('DELETE', rurl);
  request.del({
    url: rurl,
    auth: this.auth()
  }, function(err, res, body){
    if(err) return callback(err);
    this.log(res.statusCode, rurl);
    if(res.statusCode >= 400){
      var err = new Error(body);
      err.code = res.statusCode;
      return callback(err);
    }
    callback(null, JSON.parse(body));
  }.bind(this));

};


/**
 * opts: {cache:}
 */
Dpm.prototype.install = function(what, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }
  var rurl = this.url('/' + what.datapackage + (('version' in what) ?  ('/' + what.version) : ''));
  this.log('GET', rurl);

  request(rurl, function(err, res, dpkg){
    if(err) return callback(err);

    this.log(res.statusCode, rurl);
    if (res.statusCode >= 300){
      var err = new Error('fail');
      err.code = res.statusCode;
      return callback(err);
    }

    var dpkg = JSON.parse(dpkg);

    if(opts.cache && dpkg.resources.length){

      var dataPath = path.join(this.root, 'data');
      fs.mkdir(dataPath, function(err){
        if(err) return callback(err);
        async.each(dpkg.resources, function(r, cb){
          if('url' in r){
            this.log('GET', r.url);
            var req = request(r.url);
            req.on('response', function(resp){            
              var hasCallbacked = false;

              this.log(resp.statusCode, r.url);

              if(resp.statusCode >= 400){
                resp.pipe(process.stdout);
              } else {
                var filename =  r.name + '.' +mime.extension(resp.headers['content-type']);
                resp
                  .on('error', function(err){
                    if(!hasCallbacked){
                      hasCallbacked = true;
                      cb(err);
                    }
                  })
                  .pipe(fs.createWriteStream(path.join(dataPath, filename)))
                  .on('finish', function(){
                    //replace url by the path
                    delete r.url;
                    r.path = path.join('data', filename);

                    if(!hasCallbacked) cb(null);
                  });
              }              
            }.bind(this));
          } else {
            cb(null);
          }                
        }.bind(this), function(err, _){
          callback(null, dpkg);        
        });
      }.bind(this));

    } else {
      callback(null, dpkg);
    }
    
  }.bind(this));

};



Dpm.prototype.adduser = function(callback){

  var rurl = this.url('/adduser/' + this.rc.name);
  this.log('PUT', rurl);

  var data = {
    name: this.rc.name,
    email: this.rc.email
  };

  if(this.rc.sha){
    var salt = crypto.randomBytes(30).toString('hex');
    data.salt = salt;
    data.password_sha = crypto.createHash("sha1").update(this.rc.password + salt).digest("hex");
  } else {
    data.password = this.rc.password;
  }

  request.put({
    url: rurl, 
    auth: this.auth(), 
    json: data
  }, function(err, res, body){

    if(err) return callback(err);

    this.log(res.statusCode, rurl);

    if(res.statusCode < 400){
      callback(null, body);
    } else if(res.statusCode === 409){
      err = new Error('username ' + this.rc.name + ' already exists');
      err.code = res.statusCode;
      callback(err, res.headers);
    } else {
      err = new Error(JSON.stringify(body));
      err.code = res.statusCode;
      callback(err, res.headers);
    }
    
  }.bind(this));

};
