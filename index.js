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
  , githubUrl = require('github-url')
  , jsonldContextInfer = require('jsonld-context-infer');

var conf = require('rc')('ldpm', {protocol: 'https', port: 443, hostname: 'registry.standardanalytics.io', strictSSL: false, sha:true});

mime.define({
  'application/ld+json': ['jsonld'],
  'application/x-ldjson': ['ldjson', 'ldj'],
  'application/x-gzip': ['gz', 'gzip', 'tgz'] //tar.gz won't work
});

/**
 * rc is optional
 */
var Ldpm = module.exports = function(rc, root){

  if(arguments.length <2){
    root = rc;
    rc = conf;
  }

  EventEmitter.call(this);

  this.root = root || process.cwd();

  this.rc = rc;
};

util.inherits(Ldpm, EventEmitter);

/**
 * if no pkg is provided, will be read from package.jsonld
 */
Ldpm.prototype.publish = function(pkg, callback){

  if(arguments.length === 1){
    callback = pkg;
    pkg = undefined;
  }

  if(pkg){
    publish.call(this, pkg, callback);
  } else {
    fs.readFile(path.resolve(this.root, 'package.jsonld'), function(err, pkg){
      if(err) return callback(err);
      try{
        pkg = JSON.parse(pkg);
      } catch(e){
        return callback(e);
      }
      publish.call(this, pkg, callback);
    }.bind(this));
  }

};

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


Ldpm.prototype.lsOwner = function(pkgName, callback){

  var rurl = this.url('/owner/ls/' + pkgName);
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
 * data: {username, pkgname}
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
 * data: {username, pkgname}
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

Ldpm.prototype.unpublish = function(pkgId, callback){
  pkgId = pkgId.replace('@', '/');

  var rurl = this.url('/'+ pkgId);
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

Ldpm.prototype.cat = function(pkgId, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var rurl;
  if(isUrl(pkgId)){

    rurl = pkgId;
    var prurl = url.parse(rurl, true);
    if ( (prurl.hostname === 'registry.standardanalytics.io' || prurl.hostname === 'localhost') && (opts.cache && !opts.require) ){
      prurl.query = prurl.query || {};
      prurl.query.contentData = true;
      delete prurl.search;
      rurl = url.format(prurl);
    }

  } else {

    var splt = pkgId.split( (pkgId.indexOf('@') !==-1) ? '@': '/');
    var name = splt[0]
      , version;

    if(splt.length === 2){
      version = semver.valid(splt[1]);
      if(!version){
        return callback(new Error('invalid version '+ pkgId.red +' see http://semver.org/'));
      }
    } else {
      version = 'latest'
    }

    rurl = this.url('/' + name + '/' + version, (opts.cache && !opts.require) ? {contentData: true} : undefined);

  }

  this.logHttp('GET', rurl);

  var headers = (opts.expand) ? { headers: {'Accept': 'application/ld+json;profile="http://www.w3.org/ns/json-ld#expanded"'} } :
  { headers: {'Accept': 'application/ld+json;profile="http://www.w3.org/ns/json-ld#compacted"'} };

  request(this.rOpts(rurl, headers), function(err, res, pkg){

    if(err) return callback(err);

    this.logHttp(res.statusCode, rurl);
    if (res.statusCode >= 400){
      var err = new Error('fail');
      err.code = res.statusCode;
      return callback(err);
    }

    try{
      var pkg = JSON.parse(pkg);
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
    } else if(isUrl(pkg['@context'])){
      contextUrl = pkg['@context'];
    }

    if(!contextUrl){
      //TODO better handle context free case...
      return callback(null, pkg, (pkg['@context']) ? {'@context': pkg['@context']}: undefined);
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
        jsonld.expand(pkg, {expandContext: context}, function(err, pkgExpanded){
          return callback(err, pkgExpanded, context);
        });
      } else {
        pkg['@context'] = contextUrl;

        return callback(null, pkg, context);
      }

    }.bind(this));

  }.bind(this));

};


/**
 * Install a list of pkgIds and their dependencies
 * callback(err)
 */
Ldpm.prototype.install = function(pkgIds, opts, callback){

  async.map(pkgIds, function(pkgId, cb){
    this._install(pkgId, opts, function(err, pkg, context, root){
      if(err) return cb(err);
      opts = clone(opts);
      opts.root = root;
      this._installDep(pkg, opts, context, function(err){
        return cb(err, pkg);
      });
    }.bind(this));

  }.bind(this), callback);

};


/**
 * Install a pkg (without dependencies)
 */
Ldpm.prototype._install = function(pkgId, opts, callback){

  async.waterfall([

    function(cb){
      this._get(pkgId, opts, function(err, pkg, context, root){
        //console.log(util.inspect(pkg, {depth:null}));

        if(err) return cb(err);

        if(!opts.cache){
          cb(null, pkg, context, root);
        } else {
          this._cache(pkg, context, root, cb);
        }

      }.bind(this));
    }.bind(this),

    function(pkg, context, root, cb){

      var dest = path.join(root, 'package.jsonld');
      fs.writeFile(dest, JSON.stringify(pkg, null, 2), function(err){
        if(err) return cb(err);
        cb(null, pkg, context, root);
      });

    }.bind(this)

  ], callback);

};


/**
 * Install dataDependencies
 */
Ldpm.prototype._installDep = function(pkg, opts, context, callback){

  var deps = pkg.isBasedOnUrl || [];
  opts = clone(opts);
  delete opts.top;

  async.each(deps.map(function(iri){return _expandIri(context['@context']['@base'], iri);}), function(pkgId, cb){
    this._install(pkgId, opts, cb);
  }.bind(this), callback);

};


/**
 * get package.jsonld and create empty directory that will receive package.jsonld
 */
Ldpm.prototype._get = function(pkgId, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  this.cat(pkgId, opts, function(err, pkg, context){
    if(err) return callback(err);

    var root = (opts.top) ? path.join(opts.root || this.root, pkg.name) : path.join(opts.root || this.root, 'ld_packages', pkg.name);
    _createDir(root, opts, function(err){
      callback(err, pkg, context, root);
    });

  }.bind(this));
};


/**
 * cache all the resources at their path (when it exists or in ld_resources when they dont)
 */
Ldpm.prototype._cache = function(pkg, context, root, callback){

  var toCache  = (pkg.dataset || [])
    .filter(function(r){return ( r.distribution && r.distribution.contentUrl && !('contentData' in r.distribution) );})
    .map(function(r){
      return {
        name: r.name,
        type: 'dataset',
        url: r.distribution.contentUrl,
        path: r.distribution.contentPath
      }
    }).concat(
      (pkg.code || [])
        .filter(function(r){return ( r.targetProduct && r.targetProduct.downloadUrl );})
        .map(function(r){
          return {
            name: r.name,
            type: 'code',
            url: r.targetProduct.downloadUrl,
            path: r.targetProduct.filePath,
            bundlePath: r.targetProduct.bundlePath
          }
        }),
      (pkg.figure || [])
        .filter(function(r){return !!r.contentUrl ;})
        .map(function(r){
          return {
            name: r.name,
            type: 'figure',
            url: r.contentUrl,
            path: r.contentPath
          }
        }),
      (pkg.article || [])
        .filter(function(r){return r.encoding && r.encoding.contentUrl ;})
        .map(function(r){
          return {
            name: r.name,
            type: 'article',
            url: r.encoding.contentUrl,
            path: r.encoding.contentPath
          }
        })
    );

  //add README if exists
  if(pkg.about && pkg.about.url){
    toCache.push({
      url: pkg.about.url,
      path: pkg.about.name || 'README.md'  //TODO improve
    });
  }

  async.each(toCache, function(r, cb){
    cb = once(cb);

    var dirname;
    if(r.bundlePath){
      dirname  = r.bundlePath;
    } else {
      dirname  = (r.path) ? path.dirname(r.path) : 'ld_resources';
    }

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

          if(r.bundlePath){

            resp
              .pipe(zlib.createGunzip())
              .pipe(new tar.Extract({
                path: path.resolve(root, r.bundlePath),
                strip: 1
              }))
              .on('error', cb)
              .on('end', function(){
                this.emit('log', 'ldpm'.grey + ' mounted'.green + ' ' + r.name + ' at ' +  r.bundlePath);
                cb(null);
              }.bind(this));

          } else {

            var filename = (r.path) ? path.basename(r.path) : r.name + '.' + (mime.extension(resp.headers['content-type']) || r.type );

            resp
              .pipe(fs.createWriteStream(path.resolve(root, dirname, filename)))
              .on('finish', function(){
                this.emit('log', 'ldpm'.grey + ' save'.green + ' ' + (r.name || 'about') + ' at ' +  path.relative(root, path.resolve(root, dirname, filename)));

                cb(null);
              }.bind(this));

          }

        }
      }.bind(this));

    }.bind(this));

  }.bind(this), function(err){
    callback(err, pkg, context, root);
  });

};


Ldpm.prototype.adduser = function(callback){

  //chech that we need to add an user
  request.get(this.rOptsAuth(this.url('/auth')), function(err, resAuth, body){
    if(err) return callback(err, resAuth && resAuth.headers);

    if(resAuth.statusCode === 200){
      return callback(null, JSON.parse(body));
    }

    //auth failed: invalid name or password or user does not exists we try to create it

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
        if(resAuth.statusCode === 401){
          err = new Error('invalid password for user: ' + this.rc.name);
          err.code = resAuth.statusCode;
        } else {
          err = new Error('username ' + this.rc.name + ' already exists');
          err.code = res.statusCode;
        }
        callback(err, res.headers);
      } else {
        err = new Error(JSON.stringify(body));
        err.code = res.statusCode;
        callback(err, res.headers);
      }

    }.bind(this));


  }.bind(this));


};


/**
 * from paths expressed as globs (*.csv, ...) to resources
 * opts: { fFilter: function(){}, codeBundles: [] }
 */
Ldpm.prototype.paths2resources = function(globs, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  callback = once(callback);

  //supposes that codeBundles are relative path to code project directories
  var absCodeBundles = (opts.codeBundles || []).map(function(x){return path.resolve(this.root, x)}, this);

  async.map(globs, function(pattern, cb){
    glob(path.resolve(this.root, pattern), {matchBase: true}, cb);
  }.bind(this), function(err, paths){
    if(err) return cb(err);

    //filter (TODO find more elegant way (node_modules|.git) does not seem to work...)
    paths = uniq(flatten(paths))
      .filter(minimatch.filter('!**/.git/**/*', {matchBase: true}))
      .filter(minimatch.filter('!**/node_modules/**/*', {matchBase: true}))
      .filter(minimatch.filter('!**/ld_packages/**/*', {matchBase: true}))
      .filter(minimatch.filter('!**/package.jsonld', {matchBase: true}))
      .filter(minimatch.filter('!**/README.md', {matchBase: true}));

    absCodeBundles.forEach(function(x){
      paths = paths.filter(minimatch.filter('!' + path.join(x, '**/*'), {matchBase: true}));
    });

    paths = paths.filter(function(p){return p.indexOf('.') !== -1;}); //filter out directories, LICENSE...

    var fpaths = (opts.fFilter) ? paths.filter(opts.fFilter) : paths;

    async.map(fpaths, function(p, cb){
      var ext = path.extname(p);

      if(['.csv', '.tsv', '.xls', '.xlsx', '.ods', '.json', '.jsonld', '.ldjson', '.txt', '.xml', '.ttl'].indexOf(ext.toLowerCase()) !== -1){

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

        if(ext.toLowerCase() === '.csv' || ext.toLowerCase() === '.tsv'){
          jsonldContextInfer(fs.createReadStream(p).pipe(binaryCSV({json:true, separator: (ext.toLowerCase() === '.csv') ? ',': '\t'})), function(err, context){
            if(err) {
              console.error(err);
              return cb(null, {type: 'dataset', value: dataset});
            }
            dataset.about = jsonldContextInfer.about(context);
            cb(null, {type: 'dataset', value: dataset});
          });
        } else {
          cb(null, {type: 'dataset', value: dataset});
        }

      } else if (['.png', '.jpg', '.jpeg', '.gif', '.tiff', '.eps'].indexOf(ext.toLowerCase()) !== -1){

        var figure = {
          name: path.basename(p, ext),
          contentPath: path.relative(this.root, p),
          encodingFormat: mime.lookup(ext)
        };

        if(figure.contentPath.indexOf('..') !== -1){
          return cb(new Error('only figure files within ' + this.root + ' can be added (' + figure.contentPath +')'));
        }

        cb(null, {type: 'figure', value: figure});

      } else if (['.pdf', '.odt', '.doc', '.docx'].indexOf(ext.toLowerCase()) !== -1){

        var article = {
          name: path.basename(p, ext),
          encoding: {
            contentPath: path.relative(this.root, p),
            encodingFormat: mime.lookup(ext)
          }
        };

        if(article.encoding.contentPath.indexOf('..') !== -1){
          return cb(new Error('only article files within ' + this.root + ' can be added (' + article.encoding.contentPath +')'));
        }

        cb(null, {type: 'article', value: article});

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
        figure: [],
        article: []
      };

      for(var i=0; i<typedResources.length; i++){
        var r = typedResources[i];
        resources[r.type].push(r.value);
      }

      if(!absCodeBundles.length){
        return callback(null, resources, paths);
      }

      async.map(absCodeBundles, function(absPath, cb){

        var tempPath = temp.path({prefix:'ldpm-'});

        var ignore = new Ignore({
          path: absPath,
          ignoreFiles: ['.gitignore', '.npmignore', '.ldpmignore'].map(function(x){return path.resolve(absPath, x)})
        });
        ignore.addIgnoreRules(['.git', '__MACOSX', 'ld_packages', 'node_modules'], 'custom-rules');
        var ws = ignore.pipe(tar.Pack()).pipe(zlib.createGzip()).pipe(fs.createWriteStream(tempPath));
        ws.on('error', cb);
        ws.on('finish', function(){
          cb(null, {name: path.basename(absPath), targetProduct: {filePath: tempPath, bundlePath: path.relative(this.root, absPath), fileFormat:'application/x-gzip'}});
        }.bind(this));

      }.bind(this), function(err, codeResources){
        if(err) return callback(err);

        resources.code = resources.code.concat(codeResources);
        callback(null, resources, paths);

      });

    }.bind(this));

  }.bind(this));

};


/**
 * from urls to resources
 */
Ldpm.prototype.urls2resources = function(urls, callback){
  urls = uniq(urls);

  async.map(urls, function(myurl, cb){

    cb = once(cb);

    var gh = githubUrl(myurl);

    if(gh){ //github URL => code TODO: generalize
      return cb(null, { value: { name: gh.project, codeRepository: myurl }, type: 'code' });
    }

    var r = request(myurl);
    r.on('response', function(res){

      if(res.statusCode >= 400){
        return cb(new Error('could not process ' + myurl + ' code (' + res.statusCode + ')'));
      }

      var ctype = res.headers['content-type']
        , mypath = url.parse(myurl).pathname
        , myname = path.basename(mypath, path.extname(mypath));

      if ( [ 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/json', 'application/ld+json', 'application/x-ldjson' ].indexOf(ctype) !== -1 ) {

        var dataset = {
          value: {
            name: myname,
            distribution: {
              encodingFormat: ctype,
              contentUrl: myurl
            }
          },
          type: 'dataset'
        };

        if(dataset.value.distribution.encodingFormat === 'text/csv'){

          jsonldContextInfer(res.pipe(binaryCSV({json:true})), function(err, context){
            if(err) return cb(err);
            dataset.value.about = jsonldContextInfer.about(context);
            cb(null, dataset);
          });

        } else {
          res.destroy();
          cb(null, dataset);
        }

      } else if ([ 'image/png', 'image/jpeg', 'image/tiff', 'image/gif', 'image/svg+xml' ].indexOf(ctype) !== -1) {

        var figure = {
          value: {
            name: myname,
            encodingFormat: ctype,
            contentUrl: myurl
          },
          type: 'figure'
        };

        cb(null, figure);

      } else if ([ 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text' ].indexOf(ctype) !== -1) {

        var article = {
          value: {
            name: myname,
            encoding: {
              encodingFormat: ctype,
              contentUrl: myurl
            }
          },
          type: 'article'
        };

        cb(null, article);

      } else {

        res.destroy();
        cb(new Error('unsuported MIME type (' + ctype + '). It might be that the host is not setting MIME type properly'));

      }

    });

    r.on('error', cb);

  }, function (err, typedResources){
    if(err) return callback(err);

    var resources = {
      dataset: [],
      code: [],
      figure: [],
      article: []
    };

    for(var i=0; i<typedResources.length; i++){
      var r = typedResources[i];
      resources[r.type].push(r.value);
    }

    callback(null, resources);

  });

};



/**
 * add resources by taking care of removing previous
 * resources with conflicting names
 * !! resources is {dataset: [], code: [], figure: []}
 */
Ldpm.prototype.addResources = function(pkg, resources){

  for (var type in resources){
    if(resources[type].length){
      var names = resources[type].map(function(r) {return r.name;});
      pkg[type] = (pkg[type] || [])
        .filter(function(r){ return names.indexOf(r.name) === -1; })
        .concat(resources[type]);
    }
  }

  return pkg;
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
