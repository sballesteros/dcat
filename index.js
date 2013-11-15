var path = require('path')
  , request = require('request')
  , datapackage = require('datapackage');

/**
 * Note that we need cookie support (jar:true).
 */
exports.publish = function(dpkgRoot, dpkg, callback){

  request('http://127.0.0.1:3000/publish/dpkg', {jar: true, json: dpkg, method: "POST"}, function(err, res, body){

    if(res.statusCode !== 206){
      return callback(null, res.statusCode, body);
    }

    uploadResource(dpkgRoot, dpkg, body.resource, callback);
  });

};

function uploadResource(dpkgRoot, dpkg, resourceName, callback){
  var s = datapackage.createReadStream(dpkgRoot, dpkg, resourceName, {ldjsonify:true});

  var r = s.pipe(request('http://127.0.0.1:3000/publish/stream', 
                         {
                           jar: true,
                           method: "POST",
                           headers :{
                             'content-type': 'application/x-ldjson'
                           }
                         }));
  r.on('response', function(res){
    var body = [];
    res.on('data', function(chunk){
      body.push(chunk);
    })

    res.on('end', function(){
      body = Buffer.concat(body).toString();

      if(res.statusCode === 206){
        uploadResource(dpkgRoot, dpkg, body.resource, callback);
      } else {
        callback(null, res.statusCode, body);
      }

    });
  });  
};


var dpkg = require(path.resolve('test', 'data', 'package.json'));
var dpkgRoot = path.resolve('test', 'data');

exports.publish(dpkgRoot, dpkg, function(err, status, body){
  console.log(status, body);
});
