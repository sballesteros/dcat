var crypto = require('crypto')
  , url = require('url')
  , _ = require('underscore')
  , isUrl = require('is-url')
  , Ignore = require("fstream-ignore")
  , semver = require('semver')
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
  , pubmed = require('./plugin/pubmed').pubmed
  , oapmc = require('./plugin/oapmc').oapmc
  , binaryCSV = require('binary-csv')
  , split = require('split')
  , temp = require('temp')
  , githubUrl = require('github-url')
  , previewTabularData = require('preview-tabular-data').preview
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
Ldpm.prototype.publish = function(pkg, attachments, callback){

  if(arguments.length === 1){
    callback = pkg;
    pkg = undefined;
    attachments = undefined;
  } else if(arguments.length === 2) {
    callback = attachments;
    attachments = undefined;
  }

  if(pkg){
    publish.call(this, pkg, attachments, callback);
  } else {
    fs.readFile(path.resolve(this.root, 'package.jsonld'), function(err, pkg){
      if(err) return callback(err);
      try{
        pkg = JSON.parse(pkg);
      } catch(e){
        return callback(e);
      }
      publish.call(this, pkg, attachments, callback);
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


Ldpm.prototype.logHttp = function(methodCode, reqUrl, method){
  method = method || 'http';
  this.emit('log', 'ldpm'.grey + ' ' + method.green + ' ' + methodCode.toString().magenta + ' ' + reqUrl.replace(/:80\/|:443\//, '/'));
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
      return callback(err);
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

Ldpm.prototype.convert = function(id, opts, callback){

  var that = this;

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var uri = "http://www.pubmedcentral.nih.gov/utils/idconv/v1.0/?ids=" + id + '&format=json&versions=no';
  that.logHttp('GET', uri);
  request(uri,function(error, response, body){
    if(error) return callback(error);
    that.logHttp(response.statusCode, uri);

    if(response.statusCode >= 400){
      var err = new Error(body);
      err.code = response.statusCode;
      return callback(err);
    }

    //if error pubmedcentral display a webpage with 200 return code :( so we are cautious...
    try{
      body = JSON.parse(body);
    } catch(e){
      return callback(new Error(url.parse(uri).hostname + ' did not returned valid JSON'));
    }

    if(body.records && body.records.length){
      var pmcid = body.records[0].pmcid;
      var pmid = body.records[0].pmid;
      var doi = body.records[0].doi;
      if (pmcid){
        oapmc.call(that, pmcid, { pmid: pmid, doi: doi }, callback); //passing a pmid (if not undefined => add pubmed annotation)
      } else if(pmid){
        pubmed.call(that, pmid, opts, callback);
      } else {
        callback(new Error('the id cannot be recognized'));      
      }
    } else {
      callback(new Error('the id cannot be recognized'));      
    }
  });

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

  var toCache  = [];

  (pkg.dataset || []).forEach(function(r){
    if(r.distribution){
      for(var i=0; i < r.distribution.length; i++){
        if(r.distribution[i].contentUrl){
          toCache.push({
            name: r.name,
            type: 'dataset',
            url: r.distribution[i].contentUrl,
            path: r.distribution[i].contentPath
          });
        }
      }
    }
  });

  (pkg.code || []).forEach(function(r){
    if(r.targetProduct){
      for(var i=0; i < r.targetProduct.length; i++){
        if(r.targetProduct[i].downloadUrl){
          toCache.push({
            name: r.name,
            type: 'code',
            url: r.targetProduct[i].downloadUrl,
            path: r.targetProduct[i].filePath,
            bundlePath: r.targetProduct[i].bundlePath
          })
        }
      }
    }
  });

  ['article', 'figure', 'video', 'audio'].forEach(function(type){
    (pkg[type] || []).forEach(function(r){
      if(r.encoding){
        for(var i=0; i < r.encoding.length; i++){
          if(r.encoding[i].contentUrl){
            toCache.push({
              name: r.name,
              type: type,
              url: r.encoding[i].contentUrl,
              path: r.encoding[i].contentPath
            });
          }
        }
      }
    });
  });

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
 * opts: { fFilter: function(){}, codeBundles: [], root }
 */
Ldpm.prototype.paths2resources = function(globs, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var root = opts.root || this.root;

  callback = once(callback);

  //supposes that codeBundles are relative path to code project directories
  var absCodeBundles = (opts.codeBundles || []).map(function(x){return path.resolve(root, x);});

  async.map(globs, function(pattern, cb){
    glob(path.resolve(root, pattern), {matchBase: true}, cb);
  }.bind(this), function(err, paths){
    if(err) return cb(err);

    //filter (TODO find more elegant way (node_modules|.git) does not seem to work...)
    paths = _.uniq(_.flatten(paths))
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
      var ext = path.extname(p)
        , mypath = path.relative(root, p)
        , myformat = mime.lookup(ext)
        , myname = path.basename(p, ext).replace(/ /g, '-');

      if(['.csv', '.tsv', '.xls', '.xlsx', '.ods', '.json', '.jsonld', '.ldjson', '.txt', '.xml', '.ttl', '.rtf'].indexOf(ext.toLowerCase()) !== -1){

        var dataset = {
          name: myname,
          distribution: [{
            contentPath: mypath,
            encodingFormat: myformat
          }]
        };

        if(dataset.distribution[0].contentPath.indexOf('..') !== -1){ //check that all path are within root
          return cb(new Error('only dataset files within ' + root + ' can be added (' + dataset.distribution[0].contentPath +')'));
        }

        //about
        if(['.tsv', '.csv', '.ldjson', '.xls', '.xlsx' ].indexOf(ext.toLowerCase()) !== -1){
          fs.stat(p, function(err, stats){
            previewTabularData(fs.createReadStream(p), {'content-type': myformat, 'content-length': stats.size}, {nSample:100}, function(err, preview, about){
              if(err) return cb(null, {type: 'dataset', value: dataset});

              dataset.about = about;
              cb(null, {type: 'dataset', value: dataset});
            });
          });
        } else {
          cb(null, {type: 'dataset', value: dataset});
        }

      } else if (['.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.eps', '.ppt', '.pptx'].indexOf(ext.toLowerCase()) !== -1){

        var figure = {
          name: myname,
          encoding: [{
            contentPath: mypath,
            encodingFormat: myformat
          }]
        };

        if(figure.encoding[0].contentPath.indexOf('..') !== -1){
          return cb(new Error('only figure files within ' + root + ' can be added (' + figure.encoding[0].contentPath +')'));
        }

        cb(null, {type: 'figure', value: figure});

      } else if (['.pdf', '.odt', '.doc', '.docx', '.html', '.nxml'].indexOf(ext.toLowerCase()) !== -1){

        var article = {
          name: myname,
          encoding: [{
            contentPath: mypath,
            encodingFormat: myformat
          }]
        };

        if(article.encoding[0].contentPath.indexOf('..') !== -1){
          return cb(new Error('only article files within ' + root + ' can be added (' + article.encoding[0].contentPath +')'));
        }

        cb(null, {type: 'article', value: article});

      } else if (['.r', '.py', '.m','.pl'].indexOf(ext.toLowerCase()) !== -1) { //standalone executable scripts and that only (all the rest should be code bundle)

        var lang = {
          '.r': 'r',
          '.m': 'matlab',
          '.py': 'python',
          '.pl': 'perl'
        }[ext.toLowerCase()];

        var code = {
          name: myname,
          programmingLanguage: { name: lang },
          targetProduct: [{
            filePath: mypath,
            fileFormat: 'text/plain'
          }]
        };

        if(code.targetProduct[0].filePath.indexOf('..') !== -1){
          return cb(new Error('only standalone scripts within ' + root + ' can be added (' + code.targetProduct[0].filePath +')'));
        }

        cb(null, {type: 'code', value: code});

      } else if (['.wav', '.mp3', '.aif', '.aiff', '.aifc', '.m4a', '.wma', '.aac'].indexOf(ext.toLowerCase()) !== -1) {

        var audio = {
          name: myname,
          encoding: [{
            contentPath: mypath,
            encodingFormat: myformat
          }]
        };

        if(audio.endoding[0].contentPath.indexOf('..') !== -1){
          return cb(new Error('only audio files within ' + root + ' can be added (' + audio.encoding[0].contentPath +')'));
        }

        cb(null, {type: 'audio', value: audio});

      } else if (['.avi', '.mpeg', '.mov','.wmv', '.mpg', '.mp4'].indexOf(ext.toLowerCase()) !== -1) { //TODO mp4 as audio or video??

        var video = {
          name: myname,
          encoding: [{
            contentPath: mypath,
            encodingFormat: myformat
          }]
        };

        if(video.encoding[0].contentPath.indexOf('..') !== -1){
          return cb(new Error('only video files within ' + root + ' can be added (' + video.encoding[0].contentPath +')'));
        }

        cb(null, {type: 'video', value: video});

      } else {
        cb(new Error('non suported file type: ' + path.relative(root, p) + " If it is part of a code project, use --codebundle and the directory to be bundled"));
      }

    }.bind(this), function(err, typedResources){

      if(err) return callback(err);

      //for resource with same name merge different encodings      
      var byName = {
        dataset: {},
        code: {},
        figure: {},
        article: {},
        audio: {},
        video: {}
      };

      var typeMap = { 'figure': 'encoding', 'audio': 'encoding', 'video': 'encoding', 'code': 'targetProduct', 'dataset': 'distribution', 'article': 'encoding' };

      typedResources.forEach(function(r){
        if (r.value.name in byName[r.type]){          
          byName[r.type][r.value.name].push(r.value);
        } else {
          byName[r.type][r.value.name] = [r.value];
        }
      });

      var resources = {
        dataset: [],
        code: [],
        figure: [],
        article: [],
        audio: [],
        video: []
      };

      for(var rtype in byName){
        for(var rname in byName[rtype]){
          var r = {};
          for(var i=0; i< byName[rtype][rname].length; i++){
            var rr = byName[rtype][rname][i];
            Object.keys(rr).forEach(function(k){
              if(k === typeMap[rtype]){
                if(r[k]){
                  r[k].push(rr[k][0]);
                } else {
                  r[k] = [rr[k][0]];
                }
              }else{
                r[k] = rr[k];
              }
            });
          }
          resources[rtype].push(r);
        }
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
          var rb = {
            name: path.basename(absPath), 
            targetProduct: [{
              filePath: tempPath, 
              bundlePath: path.relative(root, absPath), 
              fileFormat:'application/x-gzip'
            }]
          };

          cb(null, rb);
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
  urls = _.uniq(urls);

  async.map(urls, function(myurl, cb){

    cb = once(cb);

    var gh = githubUrl(myurl);

    if(gh){ //github URL => code TODO: generalize
      return cb(null, { value: { name: gh.project, codeRepository: myurl }, type: 'code' });
    }

    request.head(myurl, function(err, resp){
      if(err) return cb(err);

      if(resp.statusCode >= 400){
        return cb(new Error('could not HEAD ' + myurl + ' code (' + resp.statusCode + ')'));
      }

      var ctype = resp.headers['content-type'].split(';')[0].trim()
        , mypath = url.parse(myurl).pathname
        , myname = path.basename(mypath, path.extname(mypath)).replace(/ /g, '-');

      if ( [ 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/tab-separated-values', 'application/json', 'application/ld+json', 'application/x-ldjson', 'text/plain' ].indexOf(ctype) !== -1 ) {

        var dataset = {
          value: {
            name: myname,
            distribution: [{
              encodingFormat: resp.headers['content-type'],
              contentUrl: myurl
            }]
          },
          type: 'dataset'
        };

        if('content-encoding' in resp.headers){
          dataset.value.distribution[0].encoding = { encodingFormat: resp.headers['content-encoding']};
          if('content-length' in resp.headers){
            dataset.value.distribution[0].encoding.contentSize = parseInt(resp.headers['content-length'], 10);
          }
        } else if('content-length' in resp.headers){
          dataset.value.distribution[0].contentSize = parseInt(resp.headers['content-length'], 10);
        }

        //auto generate about template
        if([ 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/tab-separated-values', 'application/x-ldjson' ].indexOf(ctype) !== -1){
          var r = request(myurl);
          r.on('error', cb);
          r.on('response', function(respData){
            if(respData.statusCode >= 400){
              return cb(new Error('could not GET ' + myurl + ' code (' + respData.statusCode + ')'));
            }

            previewTabularData(respData, respData.headers, {nSample:100}, function(err, preview, about){
              if(err) return cb(null, dataset);

              dataset.value.about = about;
              cb(null, dataset);
            });

          });

        } else {

          cb(null, dataset);

        }

      } else if ([ 'image/png', 'image/jpeg', 'image/tiff', 'image/gif', 'image/svg+xml', 'application/postscript', 'application/vnd.ms-powerpoint' ].indexOf(ctype) !== -1) {

        var figure = {
          value: {
            name: myname,
            encoding: [{
              encodingFormat: resp.headers['content-type'],
              contentUrl: myurl
            }]
          },
          type: 'figure'
        };

        if('content-encoding' in resp.headers){
          figure.value.encoding[0].encoding = { encodingFormat: resp.headers['content-encoding']};
          if('content-length' in resp.headers){
            figure.value.encoding[0].encoding.contentSize = parseInt(resp.headers['content-length'], 10);
          }
        } else if('content-length' in resp.headers){
          figure.value.encoding[0].contentSize = parseInt(resp.headers['content-length'], 10);
        }

        cb(null, figure);

      } else if ([ 'audio/basic', 'audio/L24', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/opus', 'audio/orbis', 'audio/vorbis', 'audio/vnd.rn-realaudio', 'audio/vnd.wave', 'audio/webl' ].indexOf(ctype) !== -1) {

        var audio = {
          value: {
            name: myname,
            encoding: [{
              encodingFormat: resp.headers['content-type'],
              contentUrl: myurl
            }]
          },
          type: 'audio'
        };

        if('content-encoding' in resp.headers){
          audio.value.encoding[0].encoding = { encodingFormat: resp.headers['content-encoding']};
          if('content-length' in resp.headers){
            audio.value.encoding[0].encoding.contentSize = parseInt(resp.headers['content-length'], 10);
          }
        } else if('content-length' in resp.headers){
          audio.value.encoding[0].contentSize = parseInt(resp.headers['content-length'], 10);
        }

        cb(null, audio);

      } else if ([ 'video/avi', 'video/mpeg', 'video/mp4', 'video/ogg', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-ms-wmv', 'audio/x-flv' ].indexOf(ctype) !== -1) {

        var video = {
          value: {
            name: myname,
            encoding: [{
              encodingFormat: resp.headers['content-type'],
              contentUrl: myurl
            }]
          },
          type: 'video'
        };

        if('content-encoding' in resp.headers){
          video.value.encoding[0].encoding = { encodingFormat: resp.headers['content-encoding']};
          if('content-length' in resp.headers){
            video.value.encoding[0].encoding.contentSize = parseInt(resp.headers['content-length'],10);
          }
        } else if('content-length' in resp.headers){
          video.value.encoding[0].contentSize = parseInt(resp.headers['content-length'],10);
        }

        cb(null, video);

      } else if ([ 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text' ].indexOf(ctype) !== -1) {

        var article = {
          value: {
            name: myname,
            encoding: [{
              encodingFormat: resp.headers['content-type'],
              contentUrl: myurl
            }]
          },
          type: 'article'
        };

        if('content-encoding' in resp.headers){
          article.value.encoding[0].encoding = { encodingFormat: resp.headers['content-encoding']};
          if('content-length' in resp.headers){
            article.value.encoding[0].encoding.contentSize = parseInt(resp.headers['content-length'], 10);
          }
        } else if('content-length' in resp.headers){
          article.value.encoding[0].contentSize = parseInt(resp.headers['content-length'], 10);
        }

        cb(null, article);

      } else {

        cb(new Error('unsuported MIME type (' + resp.headers['content-type'] + '). It might be that the host is not setting MIME type properly'));

      }

    }); //end request.head

  }, function (err, typedResources){
    if(err) return callback(err);

    var resources = {
      dataset: [],
      code: [],
      article: [],
      figure: [],
      audio: [],
      video: []
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
 * !! resources is {dataset: [], code: [], figure: [], article: [], audio: [], video: []}
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
