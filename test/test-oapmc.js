var path = require('path')
  , assert = require('assert')
  , rimraf = require('rimraf')
  , fs = require('fs')
  , temp = require('temp')
  , Ldpm = require('..');

temp.track();

var root = path.dirname(__filename);

describe('pubmed', function(){

  this.timeout(320000);

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

  it('should return a pkg with name plosone-haseleu-2014 when asked for finger-wrinkles paper through pmcid', function(done){
    temp.mkdir('__tests',function(err, dirPath) {
      var ldpm = new Ldpm(conf,dirPath);
      if(err) console.log(err);
      ldpm.convert('PMC3885627', function(err,pkg){
        assert.equal(pkg.name,'plos-one-haseleu-2013');
        done();
      });
    });
  });

  it('should return a pkg with name plosone-haseleu-2014 when asked for finger-wrinkles paper through doi', function(done){
    temp.mkdir('__tests',function(err, dirPath) {
      var ldpm = new Ldpm(conf,dirPath);
      if(err) console.log(err);
      ldpm.convert('10.1371/journal.pone.0084949', function(err,pkg){
        assert.equal(pkg.name,'plos-one-haseleu-2013');
        done();
      });
    });
  });

  it('should support articles with video and zipped supplementary material', function(done){
    // Note: in this example, a zipped video is tagged as code
    temp.mkdir('__tests',function(err, dirPath) {
      var ldpm = new Ldpm(conf,dirPath);
      if(err) console.log(err);
      ldpm.convert('10.1371/journal.pone.0012255', function(err,pkg){
        assert.equal(pkg.name,'plos-one-teramoto-2010');
        done();
      });
    });
  });

  it('should be able to inline formulas as base64', function(done){
    temp.mkdir('__tests',function(err, dirPath) {
      var ldpm = new Ldpm(conf,dirPath);
      if(err) console.log(err);
      ldpm.convert('10.1371/journal.pcbi.1000960', function(err,pkg){
        assert.equal(pkg.name,'plos-comput-biol-rapoport-2010');
        done();
      });
    });
  });

  it('should replace contentPaths with contentUrls when article comes from plos', function(done){
    temp.mkdir('__tests',function(err, dirPath) {
      var ldpm = new Ldpm(conf,dirPath);
      if(err) console.log(err);
      ldpm.convert('PMC3897745', function(err,pkg){
        if(err) console.log(err);
        pkg.figure.forEach(function(f){
          f.figure.forEach(function(x){
            assert(x.contentUrl);
            assert(!x.contentPath);
          })
        })
        done();
      });
    });
  });

});
