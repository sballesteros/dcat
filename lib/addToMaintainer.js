var http = require('http');


/**
 * data: {granter, granted, dpkgName, _id}
 */
module.exports = function addToMaintainer(data, callback){

  var data = JSON.stringify(data);
  
  var options = {
    port: 8000,
    hostname: '127.0.0.1',
    method: 'POST',
    path: '/',
    headers: { 
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  http.request(options, function(res){
    var code = res.statusCode;
    res.setEncoding('utf8');
    var data = '';
    res.on('data', function(chunk){
      data += chunk;
    });
    res.on('end', function(){
      callback(null, code, data);
    });

  }).end(data);

};
