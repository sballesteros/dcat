var path = require('path')
  , http = require('http')
  , https = require('https')
  , Ignore = require("fstream-ignore")
  , PassThrough = require("stream").PassThrough
  , temp = require('temp')
  , tar = require('tar')
  , async = require('async')
  , mime = require('mime')
  , zlib = require('zlib')
  , crypto = require('crypto')
  , cookie = require('cookie')
  , clone = require('clone')
  , once = require('once')
  , fs = require('fs')
  , couchMultipartStream = require('couch-multipart-stream');

temp.track();

mime.define({
  'application/ld+json': ['jsonld'],
  'application/x-ldjson': ['ldjson', 'ldj'],
  'application/x-gzip': ['gz', 'gzip', 'tgz'] //tar.gz won't work
});


module.exports = publish;

/**
 * 'this' is an Ldpm instance
 */

function publish(pkg, callback){

  pkg = clone(pkg);

  callback = once(callback);

  var options = {
    port: this.rc.port,
    hostname: this.rc.hostname,
    method: 'PUT',
    path: '/',
    auth: this.rc.name + ':' + this.rc.password,
    headers: {}
  };

  var http_s;

  if(this.rc.protocol === 'https'){

    options.rejectUnauthorized = false;
    options.agent = new https.Agent(options);

    http_s = https;

  } else {
    http_s = http;
  }

  _getPkgStream.call(this, pkg, function(err, pkgStream){
    if(err) return callback(err);

    Object.keys(pkgStream.headers).forEach(function(header){
      options.headers[header] = pkgStream.headers[header];
    });
    options.path +=  pkgStream._id.replace('@', '/');

    var rurl = this.url(options.path);
    this.logHttp('PUT', rurl);

    var req = http_s.request(options, function(res){
      var code = res.statusCode;
      this.logHttp(code, rurl);

      res.setEncoding('utf8');
      var data = '';
      res.on('data', function(chunk){ data += chunk; });
      res.on('end', function(){
        var err;

        if(code < 400){
          callback(null, pkgStream._id);

        } else if(code === 409){ //a previous version is already here

          err = new Error(pkgStream._id + ' has already been published');
          err.code = code;
          callback(err, res.headers);

        } else {

          err = new Error(data);
          err.code = code;
          callback(err, res.headers);

        }
      }.bind(this));
    }.bind(this));
    req.on('error', callback);

    pkgStream.pipe(req);

  }.bind(this));
};

/**
 * this is an Ldpm instance
 */

function _getPkgStream(pkg, callback){
  callback = once(callback);

  var root = this.root;

  var datasetPaths = (pkg.dataset || [])
    .filter(function(x){return ( ('distribution' in x) && ('contentPath' in x.distribution) );})
    .map(function(x){
      return {
        contentType: x.distribution.encodingFormat,
        path: x.distribution.contentPath
      }
    });

  var codePaths = (pkg.code || [])
    .filter(function(x){return ( ('targetProduct' in x) && ('filePath' in x.targetProduct) );})
    .map(function(x){
      return {
        contentType: x.targetProduct.fileFormat,
        path: x.targetProduct.filePath
      }
    });

  var figurePaths = (pkg.figure || [])
    .filter(function(x){return ( 'contentPath' in x );})
    .map(function(x){
      return {
        contentType: x.encodingFormat,
        path: x.contentPath
      }
    });

  var articlePaths = (pkg.article || [])
    .filter(function(x){return ( ('encoding' in x) && ('contentPath' in x.encoding) );})
    .map(function(x){
      return {
        contentType: x.encoding.encodingFormat,
        path: x.encoding.contentPath
      }
    });

  var sResources = datasetPaths.concat(codePaths, figurePaths, articlePaths);

  //compress everything (not ignored) but the data and the package.jsonld
  var ignore = new Ignore({
    path: root,
    ignoreFiles: ['.gitignore', '.npmignore', '.ldpmignore'].map(function(x){return path.resolve(root, x)})
  });
  ignore.addIgnoreRules(sResources.map(function(x){return x.path;}).concat(['package.jsonld', 'ld_resources', '.git', '__MACOSX', 'ld_packages', 'node_modules', 'README.md']), 'custom-rules');

  //write tarball in a temp dir
  var ws = ignore.pipe(tar.Pack()).pipe(zlib.createGzip()).pipe(temp.createWriteStream('ldpm-'));
  ws.on('error', callback);
  ws.on('finish', function(){

    for(var i=0; i<sResources.length; i++){
      sResources[i].path = path.resolve(root, sResources[i].path);
    }
    sResources.push({path: ws.path, contentType: 'application/x-gtar'});

    //get stats
    async.map(sResources, function(r, cb) { fs.stat(r.path, cb); }, function(err, stats){
      if(err) return callback(err);

      //append _attachments to package
      var wsObj = sResources.pop();
      pkg._attachments = {
        'env_.tar.gz': {follows: true, length: (stats.pop()).size, content_type: wsObj.contentType, _stream: fs.createReadStream(wsObj.path)}
      };

      sResources.forEach(function(r, i){
        pkg._attachments[path.basename(r.path)] = {
          follows: true,
          length: stats[i].size,
          'content_type': r.contentType || mime.lookup(r.path),
          _stream: fs.createReadStream(r.path)
        };
      });

      //README
      fs.stat(path.resolve(root, 'README.md'), function(err, stat){
        if(!err){
          pkg._attachments['README.md'] = {
            follows: true,
            length: stat.size,
            'content_type': mime.lookup('.md'),
            _stream: fs.createReadStream(path.resolve(root, 'README.md'))
          };
        }

        var pkgStream = couchMultipartStream(pkg);
        pkgStream._id = pkg.name + '@' + pkg.version;
        pkgStream._name = pkg.name;

        callback(null, pkgStream);

      });


    });

  });

};


/**
 * 'this' is an Ldpm instance
 * publish dataset AND edit dataset in place to add metadata
 */
function publishDataset(dataset, callback){

  if(!dataset) return callback(null);

  var self = this;

  async.each(dataset, function(x, cb){
    cb = once(cb);

    if ( ('distribution' in x) && ('contentPath' in x.distribution) ) {

      if(!x.distribution.encodingFormat){
        x.distribution.encodingFormat = mime.lookup(x.distribution.contentPath);
      }

      var p = path.resolve(self.root, x.distribution.contentPath);
      fs.stat(p, function(err, stat){
        if(err) return cb(err);
        x.distribution.contentSize = stat.size;

        var sha1 = crypto.createHash('sha1');
        var size = 0
        var s = fs.createReadStream(p).pipe(zlib.createGzip());
        s.on('error', cv);
        s.on('data', function(d) { size += d.length; sha1.update(d); });
        s.on('end', function() {
          x.encoding = { encodingFormat: 'gzip', hashAlgorithm: 'sha1', hashValue: sha1.digest('hex'), contentSize: size }l

          var headers = {
            'Content-Length': x.encoding.contentSize,
            'Content-Type': x.distribution.encodingFormat,
            'Content-Encoding': 'gzip'
          };

          var rurl = self.url('/r/' + x.encoding.hashValue);
          self.logHttp('PUT', rurl);

          var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, function(err, resp, body){
            if(err) return cb(err);
            if(resp.satusCode === 200 || resp.satusCode === 201){
              cb(null);
            } else {
              err = new Error(body);
              err.code = resp.satusCode;
              cb(err);
            }
          });
        });
      });

    } else {
      cb(null);
    }

  }, cabllback);

};
