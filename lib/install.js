var http = require('http');

module.exports = function(what, callback){

  var options = {
    port: this.rc.port,
    hostname: this.rc.hostname,
    method: 'GET',
    path: '/stan/_design/registry/_show/datapackage/' +  encodeURIComponent(what.datapackage + '@' + what.version)
  };

  var req = http.request(options, function(res){
    if (res.statusCode >= 300){
      var err = new Error('fail');
      err.code = res.statusCode;
      callback(err);
    }

    callback(null, res);    
  });
  req.on('error', console.log);
  req.end();
};
