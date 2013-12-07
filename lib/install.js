var http = require('http')

module.exports = function(what, callback){
  var mypath;

  if ('version' in what){
    mypath = '/stan/_design/registry/_rewrite/' +  encodeURIComponent(what.datapackage + '@' + what.version);
  } else {
    mypath = '/stan/_design/registry/_rewrite/' +  encodeURIComponent(what.datapackage) + '/latest';
  }

  var options = {
    port: this.rc.port,
    hostname: this.rc.hostname,
    method: 'GET',
    path: mypath
  };

  var req = http.request(options, function(res){
    if (res.statusCode >= 300){
      var err = new Error('fail');
      err.code = res.statusCode;
      callback(err);
    }

    var dpkg = '';
    res.on('data', function(chunk){ dpkg += chunk; });
    res.on('end', function(){
      callback(null, JSON.parse(dpkg));    
    });
    
  });
  req.end();
};
