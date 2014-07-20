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

  var that = this;
  pkg = clone(pkg);

  callback = once(callback);

  publishThumbnail.call(that, pkg, function(err){ //DO first because first check that thumbnailPath are indeed images..
    if(err) return callback(err);

    fs.stat(path.resolve(that.root, 'README.md'), function(err, stat){
      //treat README as an article
      if(!err){
        pkg.article = pkg.article || [];
        pkg.article.push({
          name: 'readme',
          encoding: [{
            contentPath: 'README.md',
            encodingFormat: mime.lookup('.md')
          }]
        });
      }

      publishDataset.call(that, pkg.dataset, function(err){
        if(err) return callback(err);
        publishSourceCode.call(that, pkg.sourceCode, function(err){
          if(err) return callback(err);
          publishMediaObject.call(that, pkg.image, function(err){
            if(err) return callback(err);
            publishMediaObject.call(that, pkg.audio, function(err){
              if(err) return callback(err);
              publishMediaObject.call(that, pkg.video, function(err){
                if(err) return callback(err);
                publishMediaObject.call(that, pkg.article, function(err){
                  if(err) return callback(err);

                  var options = {
                    port: that.rc.port,
                    hostname: that.rc.hostname,
                    method: 'PUT',
                    path: '/',
                    auth: that.rc.name + ':' + that.rc.password,
                    headers: {}
                  };

                  var http_s;

                  if(that.rc.protocol === 'https'){

                    options.rejectUnauthorized = false;
                    options.agent = new https.Agent(options);

                    http_s = https;

                  } else {
                    http_s = http;
                  }

                  var pkgStream = _createPkgStream(pkg, attachments);

                  Object.keys(pkgStream.headers).forEach(function(header){
                    options.headers[header] = pkgStream.headers[header];
                  });
                  options.path +=  pkgStream._id.replace('@', '/');

                  var rurl = that.url(options.path);
                  that.logHttp('PUT', rurl);

                  var req = http_s.request(options, function(res){
                    var code = res.statusCode;
                    that.logHttp(code, rurl);

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
  });
};

function _createPkgStream(pkg, attachments){
  
  if(attachments){
    pkg._attachments = {};
    Object.keys(attachments).forEach(function(key){
      pkg._attachments[key] = attachments[key];
    });
  }

  var pkgStream;

  if(pkg._attachments) {

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

  return pkgStream;
};


function _cbrequest(that, rurl, cb){
  return function(err, resp, body){
    if(err) return cb(err);
    that.logHttp(resp.statusCode, rurl);
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
  var that = this;

  async.each(dataset, function(x, cb){
    if ( 'distribution' in x ) {
      async.each(x.distribution, function(d, cb2){
        cb2 = once(cb2);

        if ('contentPath' in d) {

          if(!d.encodingFormat){
            d.encodingFormat = mime.lookup(d.contentPath);
          }

          var p = path.resolve(that.root, d.contentPath);
          fs.stat(p, function(err, stat){
            if(err) {
              return _skipIfUrlExists.call(that, err, d.contentUrl, cb2);
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
              var rurl = that.url('/r/' + d.encoding.hashValue);
              that.logHttp('PUT', rurl);
              var r = request.put( { url: rurl, auth: that.auth(), headers: headers }, _cbrequest(that, rurl, cb2));
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
 * publish MediaObject (image, audio, video, article) AND edit in place to add metadata
 */
function publishMediaObject(media, callback){

  if(!media) return callback(null);
  var that = this;

  async.each(media, function(x, cb){
    if ( 'encoding' in x ) {

      async.each(x.encoding, function(m, cb2){
        cb2 = once(cb2);

        if ('contentPath' in m) {

          if(!m.encodingFormat){
            m.encodingFormat = mime.lookup(m.contentPath);
          }

          var p = path.resolve(that.root, m.contentPath);
          fs.stat(p, function(err, stat){
            if(err) {
              return _skipIfUrlExists.call(that, err, m.contentUrl, cb2);
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

              var rurl = that.url('/r/' + m.hashValue);
              that.logHttp('PUT', rurl);
              var r = request.put( { url: rurl, auth: that.auth(), headers: headers }, _cbrequest(that, rurl, cb2));
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
 * this is an Ldpm instance
 */
function publishThumbnail(pkg, callback){
  var that = this;

  //collect thumbnailPaths and check that they are path to images AND delete from pkg
  var allThumbnailPaths = [];
  var thumbPaths;
  var i, j, k;
  var ctype;
  if(pkg.thumbnailPath){
    thumbPaths = (Array.isArray(pkg.thumbnailPath)) ? pkg.thumbnailPath: [ pkg.thumbnailPath ];
    for(i=0; i<thumbPaths.length; i++){
      ctype = mime.lookup(thumbPaths[i]);
      if(ctype.indexOf('image') === -1){
        return callback(new Error('thumbnailPath ' + thumbPaths[i] + ' does not seem to be an image'));
      }
      allThumbnailPaths.push(thumbPaths[i]);
    }   
    delete pkg.thumbnailPath;
  }

  var allTypes = ['dataset', 'sourceCode', 'image', 'audio', 'video', 'article']

  for(i=0; i<allTypes.length; i++){
    if(pkg[allTypes[i]]){
      for(j=0; j< pkg[allTypes[i]].length; j++){
        var r = pkg[allTypes[i]][j];
        if(r.thumbnailPath){
          thumbPaths = (Array.isArray(r.thumbnailPath)) ? r.thumbnailPath: [ r.thumbnailPath ];
          for(k=0; k<thumbPaths.length; k++){
            ctype = mime.lookup(thumbPaths[k]);
            if(ctype.indexOf('image') === -1){
              return callback(new Error('thumbnailPath ' + thumbPaths[k] + ' does not seem to be an image'));
            }
            allThumbnailPaths.push(thumbPaths[k]);
          }
          delete r.thumbnailPath;
        }
      }
    }
  };

  if(!allThumbnailPaths.length){
    return callback(null);
  }

  async.each(allThumbnailPaths, function(thumbnailPath, cb){
    cb = once(cb);
    var p = path.resolve(that.root, thumbnailPath);
    fs.stat(p, function(err, stat){
      if(err) return cb(err);

      var sha1 = crypto.createHash('sha1');
      var s = fs.createReadStream(p);
      s.on('error', cb);
      s.on('data', function(d) { sha1.update(d); });
      s.on('end', function() {        
        var hashValue = sha1.digest('hex');
        var contentUrl = 'r/' + m.hashValue;

        var headers = {
          'Content-Length': stat.size,
          'Content-Type': mime.lookup(p)
        };

        var rurl = that.url('/r/' + hashValue);
        that.logHttp('PUT', rurl);
        var r = request.put( { url: rurl, auth: that.auth(), headers: headers }, _cbrequest(that, rurl, cb));
        fs.createReadStream(p).pipe(r);
      });
      
    });
  }, callback);

};


/**
 * 'this' is an Ldpm instance
 * publish sourceCode AND edit sourceCode in place to add metadata AND delete filePath if codeBundle
 */
function publishSourceCode(sourceCode, callback){

  if(!sourceCode) return callback(null);

  var that = this;

  async.each(sourceCode, function(x, cb){
    if( 'targetProduct' in x ) {

      async.each(x.targetProduct, function(m, cb2){
        cb2 = once(cb2);

        if('filePath' in m) {

          //patch file format for scripts
          if(!m.fileFormat && ['.r', '.py', '.m'].indexOf(path.extname(m.filePath).toLowerCase()) !== -1) {
            m.fileFormat = 'text/plain';
          }

          var p = path.resolve(that.root, m.filePath);
          if(m.codeBundle) {
            delete m.filePath;
          }
          fs.stat(p, function(err, stat){
            if(err) {
              return _skipIfUrlExists.call(that, err, m.downloadUrl, cb2);
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

              var rurl = that.url('/r/' + m.hashValue);
              that.logHttp('PUT', rurl);
              var r = request.put( { url: rurl, auth: that.auth(), headers: headers }, _cbrequest(that, rurl, cb2));
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
