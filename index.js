var path = require('path')
  , Ignore = require("fstream-ignore")
  , PassThrough = require("stream").PassThrough
  , temp = require('temp')
  , tar = require('tar')
  , async = require('async')
  , mime = require('mime')
  , zlib = require('zlib')
  , fs = require('fs')
  , couchMultipartStream = require('couch-multipart-stream');

temp.track();

module.exports = function makeBodyStream(root, callback){

  var hasCallbacked = false;
  
  fs.readFile(path.resolve(root, 'package.json'), function(err, doc){
    if(err) return callback(err);

    try{
      doc = JSON.parse(doc);
    } catch(e){
      return callback(e);
    }

    var dataPaths = doc.resources
      .filter(function(x){return 'path' in x})
      .map(function(x){return x.path});

    //compress everything (not ignored) but the data and the package.json
    var ignore = new Ignore({
      path: root,
      ignoreFiles: ['.gitignore', '.npmignore', '.dpmignore'].map(function(x){return path.resolve(root, x)})
    });
    ignore.addIgnoreRules(dataPaths.concat(['package.json', '.git']), 'custom-rules');

    //write tarball in a temp dir    
    var ws = ignore.pipe(tar.Pack()).pipe(zlib.createGzip()).pipe(temp.createWriteStream('stan-'));
    ws.on('error', function(err){
      hasCallbacked = true;
      callback(err);
    })
    ws.on('finish', function(){
      
      dataPaths = dataPaths.map(function(p){return path.resolve(root, p);});
      dataPaths.push(ws.path);
      //get stats
      async.map(dataPaths, fs.stat, function(err, stats){
        if(err){
          if(!hasCallbacked){
            callback(err);
          }
          return;
        }

        //append _attachments to datapackage
        doc._attachments = {
          'dist.tar.gz': {follows: true, length: (stats.pop()).size, 'content_type': 'application/x-gtar', _stream: fs.createReadStream(dataPaths.pop())}
        };

        dataPaths.forEach(function(p, i){
          doc._attachments[path.basename(p)] = {
            follows: true,
            length: stats[i].size,
            'content_type': mime.lookup(p),
            _stream: fs.createReadStream(p)
          };
        });


        var bodyStream = couchMultipartStream(doc);
        bodyStream._id = doc.name + '@' + doc.version;

        callback(null, bodyStream);
        
      });

    });

  });

};
