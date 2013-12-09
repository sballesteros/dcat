var http = require('http');


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


function _request(action, data, callback){

  var data = JSON.stringify(data);

  var options = {
    port: 8000,
    hostname: '127.0.0.1',
    method: 'POST',
    path: '/owner/' + action,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  var hasCallbacked = false;

  var req = http.request(options, function(res){
    var code = res.statusCode;
    res.setEncoding('utf8');
    var data = '';
    res.on('data', function(chunk){ data += chunk; });
    res.on('end', function(){      
      if(code >= 400){
        var err = new Error(data);
        err.code = code;
        if(!hasCallbacked) callback(err);        
      }
      if(!hasCallbacked) callback(null, {code:code, data: data});
    });
  });

  req.on('error', function(err){
    hasCallbacked = true;
    callback(err);
  });
  req.end(data);
};

/**
 * data: {granter, granted, dpkgName, _id} _id is optional
 */
exports.add = function(data, callback){
  _request('add', data, callback);
};


/**
 * data: {granter, banned, dpkgName}
 */
exports.rm = function(data, callback){
  _request('rm', data, callback);
};
