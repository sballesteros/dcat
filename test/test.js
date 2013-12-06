var makeBodyStream = require('../');
var http = require('http');

makeBodyStream('data', function(err, bodyStream){
  if(err) throw err;

  var options = {
    port: 5984,
    hostname: '127.0.0.1',
    method: 'PUT',
    auth: 'seb:seb',
    path: '/stan/' + bodyStream._id,
    headers: bodyStream.headers
  };

  var req = http.request(options, function(res){
    res.setEncoding('utf8');
    res.pipe(process.stdout);
  });
  req.on('error', console.log);
  bodyStream.pipe(req);
  
});
