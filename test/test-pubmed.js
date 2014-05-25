var path = require('path')
  , assert = require('assert')
  , rimraf = require('rimraf')
  , fs = require('fs')
  , Ldpm = require('..');


var root = path.dirname(__filename);

describe('pubmed', function(){

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

  it('should return a pkg with name plosone-haseleu-2014 when asked for finger-wrinkles paper through doi', function(done){
    var ldpm = new Ldpm(conf,path.join(root+'__tests'));
    ldpm.convert('17642720', function(err,pkg){
      assert.equal(pkg.name,'indian-j-med-microbiol-padhi');
      done();
    });
  });

});
