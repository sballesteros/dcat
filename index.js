var crypto = require('crypto')
  , url = require('url')
  , isUrl = require('is-url')
  , semver = require('semver')
  , uniq = require('lodash.uniq')
  , flatten = require('lodash.flatten')
  , glob = require('glob')
  , querystring = require('querystring')
  , cookie = require('cookie')
  , EventEmitter = require('events').EventEmitter
  , util = require('util')
  , request = require('request')
  , path = require('path')
  , mime = require('mime')
  , rimraf = require('rimraf')
  , mkdirp = require('mkdirp')
  , async = require('async')
  , fs = require('fs')
  , zlib = require('zlib')
  , tar = require('tar')
  , once = require('once')
  , concat = require('concat-stream')
  , jsonld = require('jsonld')
  , clone = require('clone')
  , publish = require('./lib/publish')
  , jtsInfer = require('jts-infer');

mime.define({
  'application/ld+json': ['jsonld'],
  'application/x-ldjson': ['ldjson', 'ldj']
});


var Ldpm = module.exports = function(rc, root){
  EventEmitter.call(this);

  this.root = root || process.cwd();

  this.rc = rc;
};

util.inherits(Ldpm, EventEmitter);

Ldpm.prototype.publish = publish;

Ldpm.prototype.url = function(path, queryObj){
  return this.rc.protocol + '://'  + this.rc.hostname + ':' + this.rc.port + path + ( (queryObj) ? '?' + querystring.stringify(queryObj): '');
};

Ldpm.prototype.auth = function(){
  return {user: this.rc.name, pass: this.rc.password};
};


/**
 * create an option object for mikeal/request
 */
Ldpm.prototype.rOpts = function(myurl, extras){
  extras = extras || {};

  var opts = {
    url: myurl,
    strictSSL: false
  }

  for(var key in extras){
    opts[key] = extras[key];
  }

  return opts;
};

/**
 * create an option object for mikeal/request **with** basic auth
 */
Ldpm.prototype.rOptsAuth = function(myurl, extras){
  var opts = this.rOpts(myurl, extras);
  opts.auth = this.auth();

  return opts;
};


Ldpm.prototype.logHttp = function(methodCode, reqUrl){
  this.emit('log', 'ldpm'.grey + ' http '.green + methodCode.toString().magenta + ' ' + reqUrl.replace(/:80\/|:443\//, '/'));
};


Ldpm.prototype.lsOwner = function(dpkgName, callback){

  var rurl = this.url('/owner/ls/' + dpkgName);
  this.logHttp('GET', rurl);

  request(this.rOpts(rurl), function(err, res, body){
    if(err) return callback(err);
    this.logHttp(res.statusCode, rurl);

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
Ldpm.prototype.addOwner = function(data, callback){
  var rurl = this.url('/owner/add');
  this.logHttp('POST', rurl);
  request.post(this.rOptsAuth(rurl, {json: data}), function(err, res, body){
    if(err) return callback(err);
    this.logHttp(res.statusCode, rurl);
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
Ldpm.prototype.rmOwner = function(data, callback){
  var rurl = this.url('/owner/rm');
  this.logHttp('POST', rurl);
  request.post(this.rOptsAuth(rurl, {json: data}), function(err, res, body){
    if(err) return callback(err);
    this.logHttp(res.statusCode, rurl);
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
Ldpm.prototype.unpublish = function(dpkgId, callback){
  dpkgId = dpkgId.replace('@', '/');

  var rurl = this.url('/'+ dpkgId);
  this.logHttp('DELETE', rurl);
  request.del(this.rOptsAuth(rurl), function(err, res, body){
    if(err) return callback(err);
    this.logHttp(res.statusCode, rurl);
    if(res.statusCode >= 400){
      var err = new Error(body);
      err.code = res.statusCode;
      return callback(err);
    }
    callback(null, JSON.parse(body));
  }.bind(this));

};

Ldpm.prototype.cat = function(dpkgId, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var rurl;
  if(isUrl(dpkgId)){
    rurl = dpkgId;    
  } else {
    var splt = dpkgId.split( (dpkgId.indexOf('@') !==-1) ? '@': '/');
    var name = splt[0]
      , version;

    if(splt.length === 2){
      version = semver.valid(splt[1]);
      if(!version){
        return callback(new Error('invalid version '+ dpkgId.red +' see http://semver.org/'));
      }
    } else {
      version = 'latest'
    }

    rurl = this.url('/' + name + '/' + version, (opts.clone) ? {clone:true} : undefined);
  }

  this.logHttp('GET', rurl);

  var headers = (opts.expand) ? { headers: {'Accept': 'application/ld+json;profile="http://www.w3.org/ns/json-ld#expanded"'} }:
  { headers: {'Accept': 'application/ld+json;profile="http://www.w3.org/ns/json-ld#compacted"'} };

  request(this.rOpts(rurl, headers), function(err, res, dpkg){

    if(err) return callback(err);

    this.logHttp(res.statusCode, rurl);
    if (res.statusCode >= 400){
      var err = new Error('fail');
      err.code = res.statusCode;
      return callback(err);
    }
    
    try{
      var dpkg = JSON.parse(dpkg);
    } catch(e){
      return callback(e);
    }

    //JSON-LD get @context from Link Header
    var contextUrl;
    if(res.headers.link){
      var links =  jsonld.parseLinkHeader(res.headers.link);
      if('http://www.w3.org/ns/json-ld#context' in links){
        contextUrl = links['http://www.w3.org/ns/json-ld#context'].target;
      };
    } else if(isUrl(dpkg['@context'])){
      contextUrl = dpkg['@context'];
    }

    if(!contextUrl){
      //TODO better handle context free case...
      return callback(null, dpkg, (dpkg['@context']) ? {'@context': dpkg['@context']}: undefined);
    }

    this.logHttp('GET', contextUrl);
    request(contextUrl, function(err, res, context){
      if(err) return callback(err);
      this.logHttp(res.statusCode, contextUrl);
      if (res.statusCode >= 400){
        var err = new Error('fail');
        err.code = res.statusCode;
        return callback(err);
      }

      try {
        context = JSON.parse(context);
      } catch(e){
        return callback(e);
      }

      if(opts.expand){
        jsonld.expand(dpkg, {expandContext: context}, function(err, dpkgExpanded){
          return callback(err, dpkgExpanded, context);
        });
      } else { 
        dpkg['@context'] = contextUrl;

        return callback(null, dpkg, context);
      }

    }.bind(this));
    
  }.bind(this));

};


/**
 * Install a list of dpkgIds and their dependencies
 * callback(err)
 */
Ldpm.prototype.install = function(dpkgIds, opts, callback){
  
  async.map(dpkgIds, function(dpkgId, cb){
    this._install(dpkgId, opts, function(err, dpkg, context, root){
      if(err) return cb(err);
      opts = clone(opts);
      opts.root = root;
      this._installDep(dpkg, opts, context, function(err){
        return cb(err, dpkg);
      });     
    }.bind(this));

  }.bind(this), callback);

};


/**
 * Install a dpkg (without dataDependencies)
 */
Ldpm.prototype._install = function(dpkgId, opts, callback){

  async.waterfall([

    function(cb){
      this[(opts.all) ? '_getAll' : '_get'](dpkgId, opts, function(err, dpkg, context, root){

        if(err) return cb(err);
        
        if(!opts.cache){
          cb(null, dpkg, context, root);
        } else {        
          this._cache(dpkg, context, root, cb);
        }

      }.bind(this));    
    }.bind(this),

    function(dpkg, context, root, cb){
      
      var dest = path.join(root, 'datapackage.json');
      fs.writeFile(dest, JSON.stringify(dpkg, null, 2), function(err){
        if(err) return cb(err);
        cb(null, dpkg, context, root);
      });

    }.bind(this)
    
  ], callback);
  
};


/**
 * Install dataDependencies
 */
Ldpm.prototype._installDep = function(dpkg, opts, context, callback){
  
  var deps = dpkg.isBasedOnUrl || [];  
  opts = clone(opts);
  delete opts.top;

  async.each(deps.map(function(iri){return _expandIri(iri, context['@context']['@base']);}), function(dpkgId, cb){
    this._install(dpkgId, opts, cb);    
  }.bind(this), callback);

};


/**
 * get datapackage.json and create empty directory that will receive datapackage.json
 */
Ldpm.prototype._get = function(dpkgId, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }
  
  this.cat(dpkgId, opts, function(err, dpkg, context){
    if(err) return callback(err);

    var root = (opts.top) ? path.join(opts.root || this.root, dpkg.name) : path.join(opts.root || this.root, 'datapackages', dpkg.name);
    _createDir(root, opts, function(err){
      callback(err, dpkg, context, root);
    });

  }.bind(this));  
};


/**
 * get datapackage.json and create a directory populated by (dist_.tar.gz)
 */
Ldpm.prototype._getAll = function(dpkgId, opts, callback){

  callback = once(callback);

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  this.cat(dpkgId, opts, function(err, dpkg, context){

    if(err) return callback(err);

    var root = (opts.top) ? path.join(opts.root || this.root, dpkg.name) : path.join(opts.root || this.root, 'datapackages', dpkg.name);
    _createDir(root, opts, function(err){
      if(err) {
        return callback(err);
      }

      if(!dpkg.encoding || !(dpkg.encoding && dpkg.encoding.contentUrl)){
        return callback(new Error('--all cannot be satisfied'));
      }

      var rurl = _expandIri(dpkg.encoding.contentUrl, context['@context']['@base']);
      this.logHttp('GET', rurl);

      var req = request(this.rOpts(rurl));
      req.on('error', callback);
      req.on('response', function(resp){            

        this.logHttp(resp.statusCode, rurl);

        if(resp.statusCode >= 400){
          resp.pipe(concat(function(body){
            var err = new Error(body.toString);
            err.code = resp.statusCode;
            callback(err);
          }));
        } else {

          resp
            .pipe(zlib.createGunzip())
            .pipe(new tar.Extract({
              path: root,
              strip: 1
            }))
            .on('end', function(){
              //TODO write README.md (if exists)

              callback(null, dpkg, context, root);
            });

        }
      }.bind(this));    

    }.bind(this));

  }.bind(this));
  
};

/**
 * cache all the dataset at their path (when it exists or in .data)
 */
Ldpm.prototype._cache = function(dpkg, context, root, callback){

  var toCache = dpkg.dataset.filter(function(r){return !('data' in r);});

  //add README if exists
  if(dpkg.about && dpkg.about.url){
    toCache.push({
      distribution: {contentUrl: dpkg.about.url},
      path: dpkg.about.name || 'README.md'          
    });
  }
  
  async.each(toCache, function(r, cb){
    cb = once(cb);

    var dirname  = ('path' in r) ? path.dirname(r.path) : '.data';
    
    mkdirp(path.resolve(root, dirname), function(err) {

      if(err) return cb(err);

      var iri = _expandIri(r.distribution.contentUrl || r.distribution.isBasedOnUrl, context['@context']['@base']);

      this.logHttp('GET', iri );
      var req = request(this.rOpts(iri));
      req.on('error', cb);
      req.on('response', function(resp){            
        this.logHttp(resp.statusCode, iri);

        if(resp.statusCode >= 400){
          resp.pipe(concat(function(body){
            var err = new Error(body.toString());
            err.code = resp.statusCode;
            cb(err);
          }));
        } else {

          var filename = ('contentUrl' in r.distribution) ? path.basename(r.distribution.contentUrl) : r.name + '.' +mime.extension(resp.headers['content-type']);

          resp
            .pipe(fs.createWriteStream(path.resolve(root, dirname, filename)))
            .on('finish', cb); //TODO add path to dpkg ??? Would say no as we should not modify it ?

        }
      }.bind(this));

    }.bind(this));

  }.bind(this), function(err){
    callback(err, dpkg, context, root);
  });

};


Ldpm.prototype.adduser = function(callback){

  var rurl = this.url('/adduser/' + this.rc.name);
  this.logHttp('PUT', rurl);

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

  request.put(this.rOptsAuth(rurl, {json: data}), function(err, res, body){

    if(err) return callback(err);

    this.logHttp(res.statusCode, rurl);

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


/**
 * from paths expressed as globs (*.csv, ...) to resources
 */
Ldpm.prototype.paths2resources = function(globs, callback){

  async.map(globs, function(pattern, cb){
    glob(path.resolve(this.root, pattern), {matchBase: true}, cb);
  }.bind(this), function(err, paths){    
    if(err) return cb(err);

    paths = uniq(flatten(paths));
    
    async.map(paths, function(p, cb){
      var ext = path.extname(p);
      
      var resource = {
        name: path.basename(p, ext),
        format: ext.substring(1),
        mediatype: mime.lookup(ext),
        path: path.relative(this.root, p)
      };

      //check that all path are within this.root if not throw error
      if(resource.path.indexOf('..') !== -1){
        return cb(new Error('only data files within ' + this.root + ' can be added (' + resource.path +')'));
      }

      if(resource.format === 'csv'){

        jtsInfer(fs.createReadStream(resource.path), function(err, schema){
          if(err) return cb(err);
          resource.schema = schema;
          cb(null, resource);
        });

      } else {
        cb(null, resource);
      }

    }.bind(this), callback);

  }.bind(this));
  
};


/**
 * from urls to resources
 */
Ldpm.prototype.urls2resources = function(urls, callback){
  urls = uniq(urls);

  async.map(urls, function(myurl, cb){

    cb = once(cb);

    request.head(myurl, function(err, res){
      if(err) return cb(err);

      if(res.statusCode >= 300){
        return cb(new Error('could not process ' + myurl + ' code (' + res.statusCode + ')'));
      }

      var mypath = url.parse(myurl).pathname;

      var resource = {
        name: path.basename(mypath, path.extname(mypath)),
        mediatype: res.headers['content-type'],
        format: mime.extension(res.headers['content-type']),
        url: myurl
      };

      if(resource.format === 'csv'){
        var req = request(myurl); 
        req.on('error', cb);
        req.on('response', function(res){
          if (res.statusCode >= 300){
            return cb(new Error('could not process ' + myurl + ' code (' + res.statusCode + ')'));
          } 

          jtsInfer(req, function(err, schema){
            if(err) return cb(err);
            resource.schema = schema;
            cb(null, resource);
          });
          
        });

      } else {
        cb(null, resource);
      }

    });

  }, callback);
  
};

/**
 * add resources to dpkg.resources by taking care of removing previous
 * resources with conflicting names
 */
Ldpm.prototype.addResources = function(dpkg, resources){

  if(!('resources' in dpkg)){
    dpkg.resources = [];
  }

  var names = resources.map(function(r) {return r.name;});
  dpkg.resources = dpkg.resources
    .filter(function(r){ return names.indexOf(r.name) === -1; })
    .concat(resources);

  return dpkg;  

};


function _expandIri(iri, base){
  if(!isUrl(iri)){
    return url.resolve(base, iri);
  }
  return iri;
};


function _createDir(dirPath, opts, callback){

  fs.exists(dirPath, function(exists){
    if(exists){
      if(opts.force) {
        rimraf(dirPath, function(err){
          if(err) return callback(err);
          mkdirp(dirPath, callback);                
        });
      } else {
        callback(new Error(dirPath + ' already exists, run with --force to overwrite'));
      }
    } else {
      mkdirp(dirPath, callback);      
    }
  });

};
