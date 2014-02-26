var crypto = require('crypto')
  , url = require('url')
  , isUrl = require('is-url')
  , Ignore = require("fstream-ignore")
  , semver = require('semver')
  , uniq = require('lodash.uniq')
  , flatten = require('lodash.flatten')
  , glob = require('glob')
  , minimatch = require('minimatch')
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
  , binaryCSV = require('binary-csv')
  , split = require('split')
  , temp = require('temp')
  , jsonldContextInfer = require('jsonld-context-infer');

mime.define({
  'application/ld+json': ['jsonld'],
  'application/x-ldjson': ['ldjson', 'ldj'],
  'application/x-gzip': ['gz', 'gzip'] //tar.gz won't work
});

var Ldc = module.exports = function(rc, root){
  EventEmitter.call(this);

  this.root = root || process.cwd();

  this.rc = rc;
};

util.inherits(Ldc, EventEmitter);

Ldc.prototype.publish = publish;

Ldc.prototype.url = function(path, queryObj){
  return this.rc.protocol + '://'  + this.rc.hostname + ':' + this.rc.port + path + ( (queryObj) ? '?' + querystring.stringify(queryObj): '');
};

Ldc.prototype.auth = function(){
  return {user: this.rc.name, pass: this.rc.password};
};


/**
 * create an option object for mikeal/request
 */
Ldc.prototype.rOpts = function(myurl, extras){
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
Ldc.prototype.rOptsAuth = function(myurl, extras){
  var opts = this.rOpts(myurl, extras);
  opts.auth = this.auth();

  return opts;
};


Ldc.prototype.logHttp = function(methodCode, reqUrl){
  this.emit('log', 'ldc'.grey + ' http '.green + methodCode.toString().magenta + ' ' + reqUrl.replace(/:80\/|:443\//, '/'));
};


Ldc.prototype.lsOwner = function(ctnrName, callback){

  var rurl = this.url('/owner/ls/' + ctnrName);
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
 * data: {username, ctnrname}
 */
Ldc.prototype.addOwner = function(data, callback){
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
 * data: {username, ctnrname}
 */
Ldc.prototype.rmOwner = function(data, callback){
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

Ldc.prototype.unpublish = function(ctnrId, callback){
  ctnrId = ctnrId.replace('@', '/');

  var rurl = this.url('/'+ ctnrId);
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

Ldc.prototype.cat = function(ctnrId, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var rurl;
  if(isUrl(ctnrId)){

    rurl = ctnrId;    
    var prurl = url.parse(rurl, true);
    if ( (prurl.hostname === 'registry.standardanalytics.io' || prurl.hostname === 'localhost') && (opts.cache || opts.all)){
      prurl.query = prurl.query || {};
      prurl.query.contentData = true;
      delete prurl.search;
      rurl = url.format(prurl);
    }

  } else {

    var splt = ctnrId.split( (ctnrId.indexOf('@') !==-1) ? '@': '/');
    var name = splt[0]
      , version;

    if(splt.length === 2){
      version = semver.valid(splt[1]);
      if(!version){
        return callback(new Error('invalid version '+ ctnrId.red +' see http://semver.org/'));
      }
    } else {
      version = 'latest'
    }

    rurl = this.url('/' + name + '/' + version, (opts.cache || opts.all) ? {contentData: true} : undefined);

  }

  this.logHttp('GET', rurl);

  var headers = (opts.expand) ? { headers: {'Accept': 'application/ld+json;profile="http://www.w3.org/ns/json-ld#expanded"'} } :
  { headers: {'Accept': 'application/ld+json;profile="http://www.w3.org/ns/json-ld#compacted"'} };

  request(this.rOpts(rurl, headers), function(err, res, ctnr){

    if(err) return callback(err);

    this.logHttp(res.statusCode, rurl);
    if (res.statusCode >= 400){
      var err = new Error('fail');
      err.code = res.statusCode;
      return callback(err);
    }
    
    try{
      var ctnr = JSON.parse(ctnr);
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
    } else if(isUrl(ctnr['@context'])){
      contextUrl = ctnr['@context'];
    }

    if(!contextUrl){
      //TODO better handle context free case...
      return callback(null, ctnr, (ctnr['@context']) ? {'@context': ctnr['@context']}: undefined);
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
        jsonld.expand(ctnr, {expandContext: context}, function(err, ctnrExpanded){
          return callback(err, ctnrExpanded, context);
        });
      } else { 
        ctnr['@context'] = contextUrl;

        return callback(null, ctnr, context);
      }

    }.bind(this));
    
  }.bind(this));

};


/**
 * Install a list of ctnrIds and their dependencies
 * callback(err)
 */
Ldc.prototype.install = function(ctnrIds, opts, callback){
  
  async.map(ctnrIds, function(ctnrId, cb){
    this._install(ctnrId, opts, function(err, ctnr, context, root){
      if(err) return cb(err);
      opts = clone(opts);
      opts.root = root;
      this._installDep(ctnr, opts, context, function(err){
        return cb(err, ctnr);
      });     
    }.bind(this));

  }.bind(this), callback);

};


/**
 * Install a ctnr (without dataDependencies)
 */
Ldc.prototype._install = function(ctnrId, opts, callback){

  async.waterfall([

    function(cb){
      this[(opts.all) ? '_getAll' : '_get'](ctnrId, opts, function(err, ctnr, context, root){

        if(err) return cb(err);
        
        if(!opts.cache){
          cb(null, ctnr, context, root);
        } else {        
          this._cache(ctnr, context, root, cb);
        }
        
      }.bind(this));    
    }.bind(this),

    function(ctnr, context, root, cb){
      
      var dest = path.join(root, 'container.jsonld');
      fs.writeFile(dest, JSON.stringify(ctnr, null, 2), function(err){
        if(err) return cb(err);
        cb(null, ctnr, context, root);
      });

    }.bind(this)
    
  ], callback);
  
};


/**
 * Install dataDependencies
 */
Ldc.prototype._installDep = function(ctnr, opts, context, callback){
  
  var deps = ctnr.isBasedOnUrl || [];  
  opts = clone(opts);
  delete opts.top;

  async.each(deps.map(function(iri){return _expandIri(context['@context']['@base'], iri);}), function(ctnrId, cb){
    this._install(ctnrId, opts, cb);    
  }.bind(this), callback);

};


/**
 * get container.jsonld and create empty directory that will receive container.jsonld
 */
Ldc.prototype._get = function(ctnrId, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  this.cat(ctnrId, opts, function(err, ctnr, context){
    if(err) return callback(err);

    var root = (opts.top) ? path.join(opts.root || this.root, ctnr.name) : path.join(opts.root || this.root, 'ld_containers', ctnr.name);
    _createDir(root, opts, function(err){
      callback(err, ctnr, context, root);
    });

  }.bind(this));  
};


/**
 * get container.jsonld and create a directory populated by (env_.tar.gz)
 */
Ldc.prototype._getAll = function(ctnrId, opts, callback){

  callback = once(callback);

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  this.cat(ctnrId, opts, function(err, ctnr, context){

    if(err) return callback(err);

    var root = (opts.top) ? path.join(opts.root || this.root, ctnr.name) : path.join(opts.root || this.root, 'ld_containers', ctnr.name);
    _createDir(root, opts, function(err){
      if(err) {
        return callback(err);
      }

      if(!ctnr.encoding || !(ctnr.encoding && ctnr.encoding.contentUrl)){
        return callback(new Error('--all cannot be satisfied'));
      }

      var rurl = _expandIri(context['@context']['@base'], ctnr.encoding.contentUrl);
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

              callback(null, ctnr, context, root);
            });

        }
      }.bind(this));    

    }.bind(this));

  }.bind(this));
  
};

/**
 * cache all the resources at their path (when it exists or in .data/type when they dont)
 */
Ldc.prototype._cache = function(ctnr, context, root, callback){

  var toCache  = (ctnr.dataset || [])
    .filter(function(r){return ( r.distribution && r.distribution.contentUrl && !('contentData' in r.distribution) );})
    .map(function(r){
      return {
        name: r.name,
        type: 'dataset',
        url: r.distribution.contentUrl,
        path: r.distribution.contentPath
      }
    }).concat(
      (ctnr.code || [])
        .filter(function(r){return ( r.targetProduct && r.targetProduct.downloadUrl );})
        .map(function(r){
          return {
            name: r.name,
            type: 'code',
            url: r.targetProduct.downloadUrl,
            path: r.targetProduct.filePath
          }
        }),
      (ctnr.figure || [])
        .filter(function(r){return !!r.contentUrl ;})
        .map(function(r){
          return {
            name: r.name,
            type: 'figure',
            url: r.contentUrl,
            path: r.contentPath
          }
        })
    );

  //add README if exists TODO improve
  if(ctnr.about && ctnr.about.url){
    toCache.push({
      url: ctnr.about.url, 
      path: ctnr.about.name || 'README.md'  
    });
  }
  
  async.each(toCache, function(r, cb){
    cb = once(cb);

    var dirname  = (r.path) ? path.dirname(r.path) : '.data';
    
    mkdirp(path.resolve(root, dirname), function(err) {

      if(err) return cb(err);

      var iri = _expandIri(context['@context']['@base'], r.url);

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

          var filename = (r.path) ? path.basename(r.path) : r.name + '.' + (mime.extension(resp.headers['content-type']) || r.type );

          resp
            .pipe(fs.createWriteStream(path.resolve(root, dirname, filename)))
            .on('finish', function(){
              this.emit('log', 'ldc'.grey + ' save'.green + ' ' + (r.name || 'about') + ' at ' +  path.relative(this.root, path.resolve(root, dirname, filename)));

              cb(null);
            }.bind(this));

        }
      }.bind(this));

    }.bind(this));

  }.bind(this), function(err){
    callback(err, ctnr, context, root);
  });

};


Ldc.prototype.adduser = function(callback){

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
 * opts: { fFilter: function(){}, codeBundles: [] }
 */
Ldc.prototype.paths2resources = function(globs, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  callback = once(callback);

  //supposes that codeBundles are relative path to code project directories
  opts.codeBundles = (opts.codeBundles || []).map(function(x){return path.resolve(this.root, x)}, this);

  async.map(globs, function(pattern, cb){
    glob(path.resolve(this.root, pattern), {matchBase: true}, cb);
  }.bind(this), function(err, paths){    
    if(err) return cb(err);

    //filter (TODO find more elegant way (node_modules|.git) does not seem to work...)
    paths = uniq(flatten(paths))   
      .filter(minimatch.filter('!**/.git/**/*', {matchBase: true}))
      .filter(minimatch.filter('!**/node_modules/**/*', {matchBase: true}))
      .filter(minimatch.filter('!**/ld_containers/**/*', {matchBase: true}))
      .filter(minimatch.filter('!**/container.jsonld', {matchBase: true}))
      .filter(minimatch.filter('!**/README.md', {matchBase: true}));

    opts.codeBundles.forEach(function(x){
      paths = paths.filter(minimatch.filter('!' + path.join(x, '**/*'), {matchBase: true}));
    });

    paths = paths.filter(function(p){return p.indexOf('.') !== -1;}); //filter out directories, LICENSE...

    console.log(uniq(flatten(paths)));

    var fpaths = (opts.fFilter) ? paths.filter(opts.fFilter) : paths;

    if(!fpaths.length){
      return callback(new Error('nothing to add'));
    }

    async.map(fpaths, function(p, cb){
      var ext = path.extname(p);

      
      if(['.csv', '.xls', '.xlsx', '.ods', '.json', '.jsonld', '.ldjson', '.txt', '.xml', '.ttl'].indexOf(ext.toLowerCase()) !== -1){
        
        var dataset = {
          name: path.basename(p, ext),
          distribution: {
            contentPath: path.relative(this.root, p),
            encodingFormat: mime.lookup(ext)
          }
        };

        if(dataset.distribution.contentPath.indexOf('..') !== -1){ //check that all path are within this.root
          return cb(new Error('only dataset files within ' + this.root + ' can be added (' + dataset.distribution.contentPath +')'));
        }

        if(ext.toLowerCase() === '.csv'){
          jsonldContextInfer(fs.createReadStream(p).pipe(binaryCSV({json:true})), function(err, context){
            if(err) return cb(err);            
            dataset.about = jsonldContextInfer.about(context);
            cb(null, {type: 'dataset', value: dataset});
          });
        } else {
          cb(null, {type: 'dataset', value: dataset});
        }

      } else if (['.png', '.jpg', '.jpeg', '.gif', '.tiff', '.pdf', '.eps'].indexOf(ext.toLowerCase()) !== -1){

        var figure = {
          name: path.basename(p, ext),
          contentPath: path.relative(this.root, p),
          encodingFormat: mime.lookup(ext)
        };

        if(figure.contentPath.indexOf('..') !== -1){
          return cb(new Error('only figure files within ' + this.root + ' can be added (' + figure.contentPath +')'));
        }

        cb(null, {type: 'figure', value: figure});        
        
      } else if (['.r', '.py', '.m'].indexOf(ext.toLowerCase()) !== -1) { //standalone executable scripts and that only (all the rest should be code bundle)

        var lang = {
          '.r': 'r',
          '.m': 'matlab',
          '.py': 'python'
        }[ext.toLowerCase()];

        var code = {
          name: path.basename(p, ext),
          programmingLanguage: { name: lang },
          targetProduct: {
            filePath: path.relative(this.root, p),
            fileFormat: 'plain/text'
          }
        };

        if(code.targetProduct.filePath.indexOf('..') !== -1){
          return cb(new Error('only standalone scripts within ' + this.root + ' can be added (' + code.filePath +')'));
        }

        cb(null, {type: 'code', value: code});
        
      } else {
        cb(new Error('non suported file type: ' + path.relative(this.root, p) + " If it is part of a code project, use --codebundle and the directory to be bundled"));
      }     

    }.bind(this), function(err, typedResources){      

      if(err) return callback(err);

      var resources = {
        dataset: [],
        code: [],
        figure: []
      };

      for(var i=0; i<typedResources.length; i++){
        var r = typedResources[i];
        resources[r.type].push(r.value);
      }

      
      if(!opts.codeBundles.length){
        return callback(null, resources, paths);
      }
      
      async.map(opts.codeBundles, function(dirPath, cb){

        var tempPath = temp.path({prefix:'ldc-'});

        var ignore = new Ignore({
          path: dirPath,
          ignoreFiles: ['.gitignore', '.npmignore', '.ldcignore'].map(function(x){return path.resolve(dirPath, x)})
        });
        ignore.addIgnoreRules(['.git', '__MACOSX', 'ld_containers', 'node_modules'], 'custom-rules');
        var ws = ignore.pipe(tar.Pack()).pipe(zlib.createGzip()).pipe(fs.createWriteStream(tempPath));
        ws.on('error', cb);
        ws.on('finish', function(){
          cb(null, {name: path.basename(dirPath), targetProduct: {filePath: tempPath, fileFormat:'application/x-gzip'}});
        });

      }, function(err, codeResources){
        if(err) return callback(err);
        
        resources.code = resources.code.concat(codeResources);

        callback(null, resources, paths);
        
      });
      
    });

  }.bind(this));

};


/**
 * from urls to resources
 */
Ldc.prototype.urls2datasets = function(urls, callback){
  urls = uniq(urls);

  async.map(urls, function(myurl, cb){

    cb = once(cb);

    request.head(myurl, function(err, res){
      if(err) return cb(err);

      if(res.statusCode >= 300){
        return cb(new Error('could not process ' + myurl + ' code (' + res.statusCode + ')'));
      }

      var mypath = url.parse(myurl).pathname;

      var dataset = {
        name: path.basename(mypath, path.extname(mypath)),
        distribution: {
          encodingFormat: res.headers['content-type'],
          contentUrl: myurl
        }
      };

      if(dataset.distribution.encodingFormat === 'csv'){
        var req = request(myurl); 
        req.on('error', cb);
        req.on('response', function(res){
          if (res.statusCode >= 300){
            return cb(new Error('could not process ' + myurl + ' code (' + res.statusCode + ')'));
          }

          jsonldContextInfer(req.pipe(binaryCSV({json:true})), function(err, context){
            if(err) return cb(err);
            dataset['@context'] = context['@context'];
            cb(null, dataset);
          });

        });

      } else {
        cb(null, dataset);
      }

    });

  }, callback);
  
};



/**
 * add resources to ctnr[type] by taking care of removing previous
 * resources with conflicting names
 */
Ldc.prototype.addResources = function(ctnr, type, resources){

  if(!(type in ctnr)){
    ctnr[type] = [];
  }

  var names = resources.map(function(r) {return r.name;});
  ctnr[type] = ctnr[type]
    .filter(function(r){ return names.indexOf(r.name) === -1; })
    .concat(resources);

  return ctnr;
};


function _expandIri(base, iri){
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
