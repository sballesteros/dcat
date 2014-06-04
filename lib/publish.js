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
  , isUrl = require('is-url')
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
      publishMediaObject.call(self, pkg.figure, 'figure', function(err){
        if(err) return callback(err);
        publishMediaObject.call(self, pkg.audio, 'audio', function(err){
          if(err) return callback(err);
          publishMediaObject.call(self, pkg.video, 'video', function(err){
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
    if ( 'distribution' in x ) {
      async.each(x.distribution, function(d, cb2){
        cb2 = once(cb2);

        if ('contentPath' in d) {

          if(!d.encodingFormat){
            d.encodingFormat = mime.lookup(d.contentPath);
          }

          var p = path.resolve(self.root, d.contentPath);
          fs.stat(p, function(err, stat){
            if(err) {
              return _skipIfUrlExists.call(self, err, d.contentUrl, cb2);
            }

            d.contentSize = stat.size;

            var sha1 = crypto.createHash('sha1');
            var size = 0
            var s = fs.createReadStream(p).pipe(zlib.createGzip());
            s.on('error', cb2);
            s.on('data', function(d) { size += d.length; sha1.update(d); });
            s.on('end', function() {
              d.encoding = { encodingFormat: 'gzip', hashAlgorithm: 'sha1', hashValue: sha1.digest('hex'), contentSize: size };
              d.contentUrl = 'r/' + d.encoding.hashValue;

              var headers = {
                'Content-Length': d.encoding.contentSize,
                'Content-Type': d.encodingFormat,
                'Content-Encoding': 'gzip'
              };
              var rurl = self.url('/r/' + d.encoding.hashValue);
              self.logHttp('PUT', rurl);
              var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, _cbrequest(self, rurl, cb2));
              fs.createReadStream(p).pipe(zlib.createGzip()).pipe(r);
            });
          });

        } else {
          cb2(null);
        }

      }, cb);
    } else {
      cb(null);
    }
  }, callback);

};


/**
 * 'this' is an Ldpm instance
 * publish MediaObject (figure, audio, video) AND edit in place to add metadata
 */
function publishMediaObject(media, mediaType, callback){

  if(!media) return callback(null);
  var self = this;

  async.each(media, function(x, cb){
    if ( mediaType in x ) {

      async.each(x[mediaType], function(m, cb2){
        cb2 = once(cb2);

        if ('contentPath' in m) {

          if(!m.encodingFormat){
            m.encodingFormat = mime.lookup(m.contentPath);
          }

          var p = path.resolve(self.root, m.contentPath);
          fs.stat(p, function(err, stat){
            if(err) {
              return _skipIfUrlExists.call(self, err, m.contentUrl, cb2);
            }

            m.contentSize = stat.size;

            var sha1 = crypto.createHash('sha1');
            var s = fs.createReadStream(p);
            s.on('error', cb2);
            s.on('data', function(d) { sha1.update(d); });
            s.on('end', function() {
              m.hashAlgorithm = 'sha1';
              m.hashValue = sha1.digest('hex');
              m.contentUrl = 'r/' + m.hashValue;

              var headers = {
                'Content-Length': m.contentSize,
                'Content-Type': m.encodingFormat
              };

              var rurl = self.url('/r/' + m.hashValue);
              self.logHttp('PUT', rurl);
              var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, _cbrequest(self, rurl, cb2));
              fs.createReadStream(p).pipe(r);
            });
          });

        } else {
          cb2(null);
        }
      }, cb);

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
    if ('encoding' in x) {

      async.each(x.encoding, function(m, cb2){
        cb2 = once(cb2);

        if ( 'contentPath' in m ) {

          if(!m.encodingFormat){
            m.encodingFormat = mime.lookup(m.contentPath);
          }

          var p = path.resolve(self.root, m.contentPath);
          fs.stat(p, function(err, stat){
            if(err) {
              return _skipIfUrlExists.call(self, err, m.contentUrl, cb2);
            }

            m.contentSize = stat.size;

            var sha1 = crypto.createHash('sha1');
            var s = fs.createReadStream(p);
            s.on('error', cb2);
            s.on('data', function(d) { sha1.update(d); });
            s.on('end', function() {
              m.hashAlgorithm = 'sha1';
              m.hashValue = sha1.digest('hex');
              m.contentUrl = 'r/' + m.hashValue;

              var headers = {
                'Content-Length': m.contentSize,
                'Content-Type': m.encodingFormat
              };

              var rurl = self.url('/r/' + m.hashValue);
              self.logHttp('PUT', rurl);
              var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, _cbrequest(self, rurl, cb2));
              fs.createReadStream(p).pipe(r);
            });
          });

        } else {
          cb2(null);
        }
      }, cb);

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
    if( 'targetProduct' in x ) {

      async.each(x.targetProduct, function(m, cb2){
        cb2 = once(cb2);

        if('filePath' in m) {

          //patch file format for scripts
          if(!m.fileFormat && ['.r', '.py', '.m'].indexOf(path.extname(m.filePath).toLowerCase()) !== -1) {
            m.fileFormat = 'text/plain';
          }

          var p = path.resolve(self.root, m.filePath);
          fs.stat(p, function(err, stat){
            if(err) {
              return _skipIfUrlExists.call(self, err, m.downloadUrl, cb2);
            }

            m.fileSize = stat.size;

            var sha1 = crypto.createHash('sha1');
            var size = 0
            var s = fs.createReadStream(p);
            s.on('error', cb2);
            s.on('data', function(d) { sha1.update(d); });
            s.on('end', function() {
              m.hashAlgorithm = 'sha1';
              m.hashValue = sha1.digest('hex');
              m.downloadUrl = 'r/' + m.hashValue;

              var headers = {
                'Content-Length': m.fileSize,
                'Content-Type': m.fileFormat
              };

              var rurl = self.url('/r/' + m.hashValue);
              self.logHttp('PUT', rurl);
              var r = request.put( { url: rurl, auth: self.auth(), headers: headers }, _cbrequest(self, rurl, cb2));
              fs.createReadStream(p).pipe(r);
            });
          });

        } else {
          cb2(null);
        }
      }, cb);


    } else {
      cb(null);
    }
  }, callback);

};


/**
 * 'this' is an Ldpm instance
 **/
function _skipIfUrlExists(err, uri, callback){
  if(!uri){
    return callback(err);
  }

  var absUrl = (isUrl(uri)) ? uri : this.url('/' + uri.replace(/^\//, ''));
  request.head(absUrl, function(err, resp){
    if(err) return callback(err);

    if(resp.statusCode === 200){
      callback(null);
    } else{
      callback(new Error('resource ' + absUrl + ' cannot be HEAD (' +  resp.statusCode + ')'));
    }
  });

};
