var path = require('path')
  , http = require('http')
  , https = require('https')
  , Ignore = require("fstream-ignore")
  , PassThrough = require("stream").PassThrough
  , Readable = require('stream').Readable
  , tar = require('tar')
  , async = require('async')
  , mime = require('mime')
  , zlib = require('zlib')
  , crypto = require('crypto')
  , cookie = require('cookie')
  , clone = require('clone')
  , once = require('once')
  , request = require('request')
  , fs = require('fs')
  , couchMultipartStream = require('couch-multipart-stream');

mime.define({
  'application/ld+json': ['jsonld'],
  'application/x-ldjson': ['ldjson', 'ldj'],
  'application/x-gzip': ['gz', 'gzip', 'tgz'] //tar.gz won't work
});


module.exports = publish;

/**
 * 'this' is an Ldpm instance
 */
function publish(pkg, attachments, callback){

  if(arguments.length === 2){
    callback = attachments;
    attachments = undefined;
  }

  var self = this;
  pkg = clone(pkg);

  callback = once(callback);
  publishDataset.call(self, pkg.dataset, function(err){
    if(err) return callback(err);
    publishCode.call(self, pkg.code, function(err){
      if(err) return callback(err);
      publishFigure.call(self, pkg.figure, function(err){
        if(err) return callback(err);
        publishArticle.call(self, pkg.article, function(err){
          if(err) return callback(err);

          var options = {
            port: self.rc.port,
            hostname: self.rc.hostname,
            method: 'PUT',
            path: '/',
            auth: self.rc.name + ':' + self.rc.password,
            headers: {}
          };

          var http_s;

          if(self.rc.protocol === 'https'){

            options.rejectUnauthorized = false;
            options.agent = new https.Agent(options);

            http_s = https;

          } else {
            http_s = http;
          }

          _getPkgStream.call(self, pkg, attachments, function(err, pkgStream){
            if(err) return callback(err);

            Object.keys(pkgStream.headers).forEach(function(header){
              options.headers[header] = pkgStream.headers[header];
            });
            options.path +=  pkgStream._id.replace('@', '/');

            var rurl = self.url(options.path);
            self.logHttp('PUT', rurl);

            var req = http_s.request(options, function(res){
              var code = res.statusCode;
              self.logHttp(code, rurl);

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
              });
            });
            req.on('error', callback);
            pkgStream.pipe(req);
          });

        });
      });
    });
  });

};

/**
 * this is an Ldpm instance
 */

function _getPkgStream(pkg, attachments, callback){
  callback = once(callback);

  var root = this.root;

  if(attachments){
    pkg._attachments = {};
    Object.keys(attachments).forEach(function(key){
      pkg._attachments[key] = attachments[key];
    });
  }


  //README
  fs.stat(path.resolve(root, 'README.md'), function(err, stat){
    var pkgStream;

    if(!err || attachments) {

      if(!err){
        pkg._attachments = pkg._attachments || {};
        pkg._attachments['README.md'] = {
          follows: true,
          length: stat.size,
          'content_type': mime.lookup('.md'),
          _stream: fs.createReadStream(path.resolve(root, 'README.md'))
        };
      }

      pkgStream = couchMultipartStream(pkg);

    } else {

      pkgStream = new Readable();
      var stringified = JSON.stringify(pkg);
      pkgStream.headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(stringified)
      };

      pkgStream.push(stringified);
      pkgStream.push(null);

    }

    pkgStream._id = pkg.name + '@' + pkg.version;
    pkgStream._name = pkg.name;

    callback(null, pkgStream);

  });

};


function _cbrequest(self, rurl, cb){
  return function(err, resp, body){
    if(err) return cb(err);
    self.logHttp(resp.statusCode, rurl);
    if(resp.statusCode === 200 || resp.statusCode === 201){
      cb(null);
    } else {
      err = new Error(body);
      err.code = resp.satusCode;
      cb(err);
    }
  };
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
        s.on('error', cb);
        s.on('data', function(d) { size += d.length; sha1.update(d); });
        s.on('end', function() {
          x.encoding = { encodingFormat: 'gzip', hashAlgorithm: 'sha1', hashValue: sha1.digest('hex'), contentSize: size };
          x.distribution.contentUrl = 'r/' + x.encoding.hashValue;

          var headers = {
            'Content-Length': x.encoding.contentSize,
            'Content-Type': x.distribution.encodingFormat,
            'Content-Encoding': 'gzip'
          };

          var rurl = self.url('/r/' + x.encoding.hashValue);
          self.logHttp('PUT', rurl);
          var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, _cbrequest(self, rurl, cb));
          fs.createReadStream(p).pipe(zlib.createGzip()).pipe(r);
        });
      });

    } else {
      cb(null);
    }

  }, callback);

};



/**
 * 'this' is an Ldpm instance
 * publish figure AND edit figure in place to add metadata
 */
function publishFigure(figure, callback){

  if(!figure) return callback(null);

  var self = this;

  async.each(figure, function(x, cb){
    cb = once(cb);

    if ('contentPath' in x) {

      if(!x.encodingFormat){
        x.encodingFormat = mime.lookup(x.contentPath);
      }

      var p = path.resolve(self.root, x.contentPath);
      fs.stat(p, function(err, stat){
        if(err) return cb(err);
        x.contentSize = stat.size;

        var sha1 = crypto.createHash('sha1');
        var s = fs.createReadStream(p);
        s.on('error', cb);
        s.on('data', function(d) { sha1.update(d); });
        s.on('end', function() {
          x.hashAlgorithm = 'sha1';
          x.hashValue = sha1.digest('hex');
          x.contentUrl = 'r/' + x.hashValue;

          var headers = {
            'Content-Length': x.contentSize,
            'Content-Type': x.encodingFormat
          };

          var rurl = self.url('/r/' + x.hashValue);
          self.logHttp('PUT', rurl);
          var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, _cbrequest(self, rurl, cb));
          fs.createReadStream(p).pipe(r);
        });
      });

    } else {
      cb(null);
    }

  }, callback);

};


/**
 * 'this' is an Ldpm instance
 * publish article AND edit article in place to add metadata
 */
function publishArticle(article, callback){

  if(!article) return callback(null);

  var self = this;

  async.each(article, function(x, cb){
    cb = once(cb);

    if ( ('encoding' in x) && ('contentPath' in x.encoding) ) {

      if(!x.encoding.encodingFormat){
        x.encoding.encodingFormat = mime.lookup(x.encoding.contentPath);
      }

      var p = path.resolve(self.root, x.encoding.contentPath);
      fs.stat(p, function(err, stat){
        if(err) return cb(err);
        x.encoding.contentSize = stat.size;

        var sha1 = crypto.createHash('sha1');
        var s = fs.createReadStream(p);
        s.on('error', cb);
        s.on('data', function(d) { sha1.update(d); });
        s.on('end', function() {
          x.encoding.hashAlgorithm = 'sha1';
          x.encoding.hashValue = sha1.digest('hex');
          x.encoding.contentUrl = 'r/' + x.encoding.hashValue;

          var headers = {
            'Content-Length': x.encoding.contentSize,
            'Content-Type': x.encoding.encodingFormat
          };

          var rurl = self.url('/r/' + x.encoding.hashValue);
          self.logHttp('PUT', rurl);
          var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, _cbrequest(self, rurl, cb));
          fs.createReadStream(p).pipe(r);
        });
      });

    } else {
      cb(null);
    }

  }, callback);

};



/**
 * 'this' is an Ldpm instance
 * publish code AND edit code in place to add metadata
 */
function publishCode(code, callback){

  if(!code) return callback(null);

  var self = this;

  async.each(code, function(x, cb){
    cb = once(cb);

    if( ('targetProduct' in x) && ('filePath' in x.targetProduct) ) {

      if(!x.targetProduct.fileFormat) {
//        x.targetProduct.fileFormat = mime.lookup(x.targetProduct.filePath); //TODO fix maybe set to text/plain
      }

      var p = path.resolve(self.root, x.targetProduct.filePath);
      fs.stat(p, function(err, stat){
        if(err) return cb(err);
        x.targetProduct.fileSize = stat.size;

        var sha1 = crypto.createHash('sha1');
        var size = 0
        var s = fs.createReadStream(p);
        s.on('error', cb);
        s.on('data', function(d) { sha1.update(d); });
        s.on('end', function() {
          x.targetProduct.hashAlgorithm = 'sha1';
          x.targetProduct.hashValue = sha1.digest('hex');
          x.targetProduct.downloadUrl = 'r/' + x.targetProduct.hashValue;

          var headers = {
            'Content-Length': x.targetProduct.fileSize,
            'Content-Type': x.targetProduct.fileFormat
          };

          var rurl = self.url('/r/' + x.targetProduct.hashValue);
          self.logHttp('PUT', rurl);
          var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, _cbrequest(self, rurl, cb));
          fs.createReadStream(p).pipe(r);
        });
      });

    } else {
      cb(null);
    }

  }, callback);

};
