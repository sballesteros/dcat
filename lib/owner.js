var http = require('http')
  , request = require('./request');

exports.ls = function(dpgkName, callback){

  var options = {
    port: 8000,
    hostname: '127.0.0.1',
    method: 'GET',
    path: '/owner/ls/' + dpkgName
  };

  http.request(options, function(res){
    var code = res.statusCode;
    res.setEncoding('utf8');
    var data = '';
    res.on('data', function(chunk){ data += chunk; });
    res.on('end', function(){      
      if(code >= 400){
        var err = new Error(data);
        err.code = code;
        callback(err);
      }
      callback(null, JSON.parse(data));
    });    
  }).end();
  
};

/**
 * data: {username, dpkgName}
 */
exports.add = function(data, callback){
  this.request('/owner/add', data, callback);
};

/**
 * data: {username, dpkgName}
 */
exports.rm = function(data, callback){
  this.request('/owner/rm', data, callback);
};
