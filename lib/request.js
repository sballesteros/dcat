var http = require('http');

/**
 * data is optional
 */
module.exports = function(path, data, callback){

  var method;
  if(arguments.length === 2){
    callback = data;
    data = undefined;
    method = 'DELETE'
  } else {
    method = 'POST'
  }

  var options = {
    port: this.rc.port,
    hostname: this.rc.hostname,
    method: method,
    path: path,
    auth: this.rc.name + ':' + this.rc.password
  }

  if(data){
    data = JSON.stringify(data);
    options.headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    };
  }

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

  if(data){
    req.end(data);
  } else {
    req.end();
  }

};
