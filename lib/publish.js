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

function publish(callback){

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

  _getPkgStream.call(this, function(err, pkgStream){
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

function _getPkgStream(callback){
  callback = once(callback);

  var root = this.root;

  fs.readFile(path.resolve(root, 'package.jsonld'), function(err, doc){
    if(err) return callback(err);

    try{
      doc = JSON.parse(doc);
    } catch(e){
      return callback(e);
    }

    var datasetPaths = (doc.dataset || [])
      .filter(function(x){return ( ('distribution' in x) && ('contentPath' in x.distribution) );})
      .map(function(x){
        return {
          contentType: x.distribution.encodingFormat,
          path: x.distribution.contentPath
        }
      });

    var codePaths = (doc.code || [])
      .filter(function(x){return ( ('targetProduct' in x) && ('filePath' in x.targetProduct) );})
      .map(function(x){
        return {
          contentType: x.targetProduct.fileFormat,
          path: x.targetProduct.filePath
        }
      });

    var figurePaths = (doc.figure || [])
      .filter(function(x){return ( 'contentPath' in x );})
      .map(function(x){
        return {
          contentType: x.encodingFormat,
          path: x.contentPath
        }
      });


    var sResources = datasetPaths.concat(codePaths, figurePaths);
    
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
        doc._attachments = {
          'env_.tar.gz': {follows: true, length: (stats.pop()).size, content_type: wsObj.contentType, _stream: fs.createReadStream(wsObj.path)}
        };

        sResources.forEach(function(r, i){
          doc._attachments[path.basename(r.path)] = {
            follows: true,
            length: stats[i].size,
            'content_type': r.contentType || mime.lookup(r.path),
            _stream: fs.createReadStream(r.path)
          };
        });
        
        //README
        fs.stat(path.resolve(root, 'README.md'), function(err, stat){
          if(!err){
            doc._attachments['README.md'] = {
              follows: true,
              length: stat.size,
              'content_type': mime.lookup('.md'),
              _stream: fs.createReadStream(path.resolve(root, 'README.md'))
            };
          }
          
          var pkgStream = couchMultipartStream(doc);
          pkgStream._id = doc.name + '@' + doc.version;
          pkgStream._name = doc.name;

          callback(null, pkgStream);

        });
        

      });

    });

  }.bind(this));

};
