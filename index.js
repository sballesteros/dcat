var http = require('http')
  , querystring = require('querystring')
  , cookie = require('cookie')
  , request = require('request')
  , path = require('path')
  , mime = require('mime')
  , async = require('async')
  , fs = require('fs')
  , _request = require('./lib/request')
  , publish = require('./lib/publish');

var Dpm = module.exports = function(rc, root){
  this.root = root || process.cwd();

  this.rc = rc;
};


Dpm.prototype.publish = publish;

Dpm.prototype.request = _request;

Dpm.prototype.url = function(path, queryObj){
  return 'http://' + this.rc.hostname + ':' + this.rc.port + path + ( (queryObj) ? '?' + querystring.stringify(queryObj): '');
}

Dpm.prototype.lsOwner = function(dpgkName, callback){

  var options = {
    port: this.rc.port,
    hostname: this.rc.hostname,
    method: 'GET',
    path: '/owner/ls/' + dpkgName
  };

  http.request(options, function(res){
    var code = res.statusCode;
    res.setEncoding('utf8');
    var data = '';
    res.on('data', function(chunk){ data += chunk; });
    res.on('end', function(){      
      if(code >= 400){
        var err = new Error(data);
        err.code = code;
        callback(err);
      }
      callback(null, JSON.parse(data));
    });    
  }).end();
  
};

/**
 * data: {username, dpkgName}
 */
Dpm.prototype.addOwner = function(data, callback){
  this.request('/owner/add', data, callback);
};

/**
 * data: {username, dpkgName}
 */
Dpm.prototype.rmOwner = function(data, callback){
  this.request('/owner/rm', data, callback);
};


/**
 * data: {dpkgName[@version]}
 */
Dpm.prototype.unpublish = function(dpkgId, callback){
  dpkgId = dpkgId.replace('@', '/');

  this.request('/unpublish/'+ dpkgId, callback);
};


/**
 * opts: {cache:}
 */
Dpm.prototype.install = function(what, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  request(this.url('/install/' + what.datapackage + (('version' in what) ?  ('/' + what.version) : '')), function(err, res, dpkg){

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
            var req = request(r.url);
            req.on('response', function(resp){            
              var hasCallbacked = false;

              if(resp.statusCode >= 400){
                resp.pipe(process.stdout);
              } else {
                resp
                  .on('error', function(err){
                    if(!hasCallbacked){
                      hasCallbacked = true;
                      cb(err);
                    }
                  })
                  .pipe(fs.createWriteStream(path.join(dataPath, r.name + '.' +mime.extension(resp.headers['content-type']))))
                  .on('finish', function(){
                    if(!hasCallbacked) cb(null);
                  });
              }              
            });
          } else {
            cb(null);
          }                
        }, function(err, _){
          callback(null, dpkg);        
        });
      });

    } else {
      callback(null, dpkg);
    }
    
  }.bind(this));

};


Dpm.prototype.adduser = function(callback){

  var data = JSON.stringify({
    name: this.rc.name,
    password: this.rc.password,
    email: this.rc.email
  });
  
  var options = {
    port: this.rc.port,
    hostname: this.rc.hostname,
    method: 'PUT',
    path: '/adduser/' + this.rc.name,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data, 'utf8')
    }
  };
  
  http.request(options, function(res){
    var code = res.statusCode;
    res.setEncoding('utf8');
    var data = '';
    res.on('data', function(chunk){
      data += chunk;
    });
    res.on('end', function(){
      var err;

      if(code === 201){
        
        callback(null, JSON.parse(data));

      } else if(code === 409){

        err = new Error('username ' + this.rc.name + ' already exists');
        err.code = code;
        callback(err, res.headers);

      } else {

        err = new Error(data);
        err.code = code;
        callback(err, res.headers);

      }
    }.bind(this));        
  }.bind(this)).end(data);


};
