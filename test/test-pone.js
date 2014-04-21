var path = require('path')
  , assert = require('assert')
  , Ldpm = require('..')
  , pone = require('../plugin/pone');


var root = path.dirname(__filename);

describe('pone', function(){

  this.timeout(40000);

  var conf = {
    protocol: 'http',
    port: 3000,
    hostname: 'localhost',
    strictSSL: false,
    sha:true,
    name: "user_a",
    email: "user@domain.com",
    password: "user_a"
  };

  it('should return a pkg with name haseleu-2014 when asked for finger-wrinkles paper through url', function(done){
    var ldpm = new Ldpm(conf);
    ldpm.markup('plosone', 'http://www.plosone.org/article/info%3Adoi%2F10.1371%2Fjournal.pone.0084949', function(err,pkg){
      assert.equal(pkg.name,'haseleu-2014');
      done();
    });
  });

  it('should return a pkg with name haseleu-2014 when asked for finger-wrinkles paper through doi', function(done){
    var ldpm = new Ldpm(conf);
    ldpm.markup('plosone', '10.1371/journal.pone.0084949', function(err,pkg){
      assert.equal(pkg.name,'haseleu-2014');
      done();
    });
  });

  it('should error 404 if article does not exist', function(done){
    var ldpm = new Ldpm(conf);
    ldpm.markup('plosone','http://www.plosone.org/article/info%3Adoi%2F10.1371%2Fjournal.pone.9999999', function(err,pkg){
      assert.equal(err.code, '404');
      done();
    });
  });

  it('should error 400 if url does not start with http://www.plosone.org/article/info', function(done){
    var ldpm = new Ldpm(conf);
    ldpm.markup('plosone','http://google.com', function(err,pkg){
      assert.equal(err.code, '400');
      done();
    });
  });

});
