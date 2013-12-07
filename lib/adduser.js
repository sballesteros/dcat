var http = require('http');

module.exports = adduser;

function adduser(callback){

  var data = JSON.stringify({
    _id: 'org.couchdb.user:' + this.rc.name,
    name: this.rc.name,
    roles: [],
    type: 'user',
    password: this.rc.password,
    email: this.rc.email,
    date: (new Date()).toISOString(),
    maintains: []
  });

  var options = {
    port: this.rc.port,
    hostname: this.rc.hostname,
    method: 'PUT',
    path: '/_users/org.couchdb.user:' + this.rc.name,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data, 'utf8')
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
      var err;

      if(code === 201){
        
        callback(null, JSON.parse(data));

      } else if(code === 409){

        err = new Error('username ' + this.rc.name + ' already exists');
        err.code = code;
        callback(err, res.headers);

      } else {

        err = new Error(data);
        err.code = code;
        callback(err, res.headers);

      }
    }.bind(this));        
  }.bind(this)).end(data);

};
