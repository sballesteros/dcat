var path = require('path')
  , http = require('http')
  , Ignore = require("fstream-ignore")
  , PassThrough = require("stream").PassThrough
  , temp = require('temp')
  , tar = require('tar')
  , async = require('async')
  , mime = require('mime')
  , zlib = require('zlib')
  , cookie = require('cookie')
  , clone = require('clone')
  , fs = require('fs')
  , couchMultipartStream = require('couch-multipart-stream');

temp.track();

module.exports = publish;

function publish(token, callback){
  var headers = {
    'X-CouchDB-WWW-Authenticate': 'Cookie',
    'Cookie': cookie.serialize('AuthSession', token)
  };

  var options = {
    port: this.rc.port,
    hostname: this.rc.hostname,
    method: 'PUT',
    path: '',
    headers: headers
  };

  _getDpkgStream.call(this, function(err, dpkgStream){
    if(err) return callback(err);

    var req = http.request(_updOptions(options, dpkgStream), function(res){
      var code = res.statusCode;
      res.setEncoding('utf8');
      var data = '';
      res.on('data', function(chunk){ data += chunk; });
      res.on('end', function(){
        var err;

        if(code === 201){

          this.addOwner({granter: this.rc.name, granted: this.rc.name, dpkgName: dpkgStream._name, _id: dpkgStream._id}, callback);

        } else if(code === 409){ //a previous version is already here

          err = new Error(dpkgStream._id + ' has already been published');
          err.code = code;
          callback(err, res.headers);

        } else {

          err = new Error(data);
          err.code = code;
          callback(err, res.headers);

        }
      }.bind(this));
    }.bind(this));
    dpkgStream.pipe(req);

  }.bind(this));
};




function _updOptions(options, dpkgStream){

  options = clone(options);
  Object.keys(dpkgStream.headers).forEach(function(header){
    options.headers[header] = dpkgStream.headers[header];
  });
  options.path = '/registry/' + dpkgStream._id;

  return options;
}




function _getDpkgStream(callback){

  var hasCallbacked = false;
  var root = this.root;

  fs.readFile(path.resolve(root, 'package.json'), function(err, doc){
    if(err) return callback(err);

    try{
      doc = JSON.parse(doc);
    } catch(e){
      return callback(e);
    }

    doc.date = (new Date).toISOString();
    doc.username = this.rc.name;

    var data = doc.resources.filter(function(x){return 'path' in x});

    var dataPaths = data.map(function(x){return x.path});
    var dataNames = data.map(function(x){return x.name});

    //compress everything (not ignored) but the data and the package.json
    var ignore = new Ignore({
      path: root,
      ignoreFiles: ['.gitignore', '.npmignore', '.dpmignore'].map(function(x){return path.resolve(root, x)})
    });
    ignore.addIgnoreRules(dataPaths.concat(['package.json', '.git']), 'custom-rules');

    //write tarball in a temp dir
    var ws = ignore.pipe(tar.Pack()).pipe(zlib.createGzip()).pipe(temp.createWriteStream('dpm-'));
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
          doc._attachments[dataNames[i] + path.extname(p)] = {
            follows: true,
            length: stats[i].size,
            'content_type': mime.lookup(p),
            _stream: fs.createReadStream(p)
          };
        });

        var dpkgStream = couchMultipartStream(doc);
        dpkgStream._id = doc.name + '@' + doc.version;
        dpkgStream._name = doc.name;

        callback(null, dpkgStream);
      });

    });

  }.bind(this));

};
