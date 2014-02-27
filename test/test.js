var util = require('util')
  , fs = require('fs')
  , clone = require('clone')
  , temp = require('temp')
  , assert = require('assert')
  , request = require('request')
  , Ldc = require('..')
  , readdirpSync = require('fs-readdir-recursive')
  , difference = require('lodash.difference')
  , exec = require('child_process').exec
  , path = require('path');

temp.track();

var root = path.dirname(__filename);

describe('ldc', function(){
  this.timeout(10000);

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

  function rurl(path){
    return conf.protocol + '://' + conf.hostname + ((conf.port !== 80) ? ':' + conf.port: '') + path;
  };

  function rm(db, id, cb){
    db['head'](id, function(err, _, headers){
      var etag = (headers && headers.etag.replace(/^"(.*)"$/, '$1')) || '';    
      db['destroy'](id, etag, function(err, _, _){
        cb();
      });
    });
  };

  function rmFixtures (cb){
    request.del( { url: rurl('/myctnr-test'), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
      request.del( { url: rurl('/req-test'), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
        request.del( { url: rurl('/rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
          request.del( { url: rurl('/rmuser/user_b'), auth: {user: 'user_b', pass: conf.password} }, function(err, resp, body){
            cb();
          });
        });
      });
    });
  };

  describe.skip('init', function(){

    var expected = {
      license: 'CC0-1.0',
      description: 'my container description',
      dataset: [
        {
          name: 'x1',
          about: [
            { name: 'a', valueType: 'xsd:integer' },
            { name: 'b', valueType: 'xsd:integer' }
          ],
          distribution: { 
            contentPath: 'x1.csv',
            encodingFormat: 'csv' 
          }
        }
      ]
    };

    it('should create a container.jsonld with default values', function(done){      
      exec(path.join(path.dirname(root), 'bin', 'ldc') + ' init "*.csv" --defaults', {cwd: path.join(root, 'fixtures', 'init-test') }, function(err, stdout, stderr){
        var ctnr = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'init-test', 'container.jsonld'), 'utf8'));
        delete ctnr.author;
        assert.deepEqual(ctnr, expected);
        done();
      });
    });

    it('should create a container.jsonld with default values and do not include content of node_modules or container.jsonld in case we ask to recursively include everything', function(done){      
      exec(path.join(path.dirname(root), 'bin', 'ldc') + ' init "**/*" --defaults', {cwd: path.join(root, 'fixtures', 'init-test') }, function(err, stdout, stderr){
        var ctnr = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'init-test', 'container.jsonld'), 'utf8'));
        delete ctnr.author;
        assert.deepEqual(ctnr, expected);
        done();
      });
    });

  });

  describe.skip('publish', function(){
    var ldc1, ldc2;

    before(function(done){
      ldc1 = new Ldc(conf, path.join(root, 'fixtures', 'myctnr-test'));
      ldc2 = new Ldc(conf, path.join(root, 'fixtures', 'req-test'));

      ldc1.adduser(function(err, headers){
        done()
      });
    });
    
    it('should publish a container with attachments and raise an error with code if the ctnr is republished', function(done){
      ldc1.publish(function(err, id){
        assert.equal('myctnr-test@0.0.0', id);
        ldc1.publish(function(err, id){     
          assert.equal(err.code, 409);
          done();
        });
      });
    });

    it('should publish a container without attachments', function(done){
      ldc2.publish(function(err, id){
        assert.equal('req-test@0.0.0', id);
        done();
      });
    });

    after(function(done){
      rmFixtures(done);
    });

  });

           
  describe.skip('unpublish', function(){
    var ldc1;

    before(function(done){
      ldc1 = new Ldc(conf, path.join(root, 'fixtures', 'myctnr-test'));
      ldc1.adduser(function(err, headers){
        ldc1.publish(function(err, id){
          done();
        })
      });
    });
    
    it('should unpublish a ctnr', function(done){
      ldc1.unpublish('myctnr-test', function(err, res){
        assert.deepEqual(res, {ok:true});
        done();
      });
    });

    after(function(done){
      rmFixtures(done);
    });

  });


  describe.skip('owner', function(){

    var expected = [ 
      {name: 'user_a', email: 'user@domain.com'},
      {name: 'user_b', email: 'user@domain.com'}
    ];

    var ldc1, ldc2;
    before(function(done){
      ldc1 = new Ldc(conf, path.join(root, 'fixtures', 'req-test'));
      var conf2 = clone(conf);
      conf2.name = 'user_b';
      ldc2 = new Ldc(conf2, path.join(root, 'fixtures', 'req-test'));

      ldc1.adduser(function(err, headers){
        ldc2.adduser(function(err, id){
          ldc1.publish(function(err, body){
            done();
          });
        });
      });
    });
    
    it('should list the maintainers', function(done){
      ldc1.lsOwner('req-test', function(err, maintainers){
        assert.deepEqual(maintainers, expected.slice(0, 1));
        done();
      });    
    });

    it('should add a maintainer then remove it', function(done){
      ldc1.addOwner({username: 'user_b', ctnrname: 'req-test'}, function(err){
        ldc1.lsOwner('req-test', function(err, maintainers){
          assert.deepEqual(maintainers, expected);
          ldc1.rmOwner({username: 'user_b', ctnrname: 'req-test'}, function(err){
            ldc1.lsOwner('req-test', function(err, maintainers){
              assert.deepEqual(maintainers, expected.slice(0, 1));
              done();
            });
          });
        });
      });
    });

    it("should err", function(done){
      ldc1.addOwner({username: 'user_c', ctnrname: 'req-test'}, function(err){
        assert.equal(err.code, 404);
        done();
      })      
    });

    after(function(done){
      rmFixtures(done);
    });

  });
  
  describe.skip('cat', function(){

    var ldc1, ldc2;

    var expected = { 
//      '@context': 'http://localhost:3000/container.jsonld',
      '@id': 'req-test/0.0.0',
      '@type': ['Container', 'DataCatalog'],
      name: 'req-test',
      description: 'a test for data dependencies',
      about: { name: 'README.md', url: 'req-test/0.0.0/about/README.md' },
      isBasedOnUrl: [ 'myctnr-test/0.0.0' ],
      version: '0.0.0',
      keywords: [ 'test', 'container' ],
      dataset: [
        {
          '@id': 'req-test/0.0.0/dataset/azerty',
          '@type': 'Dataset',
          name: 'azerty',
          distribution:  {
            '@type': 'DataDownload' ,
            contentUrl: 'myctnr-test/0.0.0/dataset/csv1/x1.csv',
            //uploadDate: '2014-01-12T05:11:48.221Z',
          },
          catalog: { '@type': ['Container', 'DataCatalog'], name: 'req-test', version: '0.0.0', url: 'req-test/0.0.0' } 
        }
      ],
//      datePublished: '2014-01-12T05:11:48.220Z',
      encoding: {
        contentUrl: 'req-test/0.0.0/env/env_.tar.gz',
        contentSize: 29,
        'encodingFormat': 'application/x-gtar',
        hashAlgorithm: 'md5',
        hashValue: '31f6566d35ccd604be46ed5b1f813cdf'      
      },
      registry: { name: 'Standard Analytics IO', url: 'https://registry.standardanalytics.io/' }
    };

    before(function(done){
      ldc1 = new Ldc(conf, path.join(root, 'fixtures', 'myctnr-test'));
      ldc2 = new Ldc(conf, path.join(root, 'fixtures', 'req-test'));

      ldc1.adduser(function(err, headers){
        ldc1.publish(function(err, id){
          ldc2.publish(function(err, body){
            done();
          });
        });
      });
    });

    it('should error if we cat unexisting ctnr', function(done){
      ldc2.cat('reqxddwdwdw@0.0.0', function(err, ctnr){
        assert.equal(err.code, 404);
        done();
      });
    });

    it('should cat the ctnr as JSON-LD', function(done){
      ldc2.cat('req-test@0.0.0', function(err, ctnr){
        assert('@context' in ctnr);
        delete ctnr['@context'];
        assert('datePublished' in ctnr);
        delete ctnr.datePublished;
        assert('uploadDate' in ctnr.dataset[0].distribution);
        delete ctnr.dataset[0].distribution.uploadDate;
        assert.deepEqual(expected, ctnr);
        done();
      });
    });

    it('should cat the latest ctnr when version is not specified', function(done){
      ldc2.cat('req-test', function(err, ctnr){
        assert.equal(expected.version, ctnr.version);
        done();
      });
    });

    after(function(done){
      rmFixtures(done);
    });
    
  });

  describe.skip('files', function(){
    var ldc1, ldc2;
    before(function(done){
      ldc1 = new Ldc(conf, path.join(root, 'fixtures', 'req-test'));
      ldc1.adduser(function(err, headers){
        ldc1.publish(function(err, body){
          ldc2 = new Ldc(conf, path.join(root, 'fixtures', 'myctnr-test'));
          ldc2.publish(function(err, body){
            done();
          });
        });
      });
    });

    it('should install req-test@0.0.0 (and its dependencies) at the top level and cache data', function(done){
      temp.mkdir('test-ldc-', function(err, dirPath) {
        var ldc = new Ldc(conf, dirPath);
        ldc.install(['req-test@0.0.0'], {top: true, cache: true}, function(err){
          var files = readdirpSync(path.join(dirPath, 'req-test'));

          var expected = [ 
            path.join('ld_containers', 'myctnr-test', 'container.jsonld'), 
            path.join('ld_containers', 'myctnr-test', 'x1.csv'), 
            path.join('ld_containers', 'myctnr-test', 'x2.csv'),
            path.join('ld_containers', 'myctnr-test', 'scripts', 'test.r'),
            path.join('ld_containers', 'myctnr-test', 'img', 'daftpunk.jpg'),
            path.join('ld_containers', 'myctnr-test', 'README.md'),
            path.join('ld_resources', 'azerty.csv'),
            'container.jsonld',
            'README.md'
          ];

          assert(files.length && difference(files, expected).length === 0);
          done();
        });
      });
    });


    it('should install req-test@0.0.0 (and its dependencies) and cache data', function(done){
      temp.mkdir('test-ldc-', function(err, dirPath) {
        var ldc = new Ldc(conf, dirPath);
        ldc.install(['req-test@0.0.0'], {cache: true}, function(err){
          var files = readdirpSync(path.join(dirPath, 'ld_containers'));

          var expected = [ 
            path.join('req-test', 'ld_containers', 'myctnr-test', 'container.jsonld'), 
            path.join('req-test', 'ld_containers', 'myctnr-test', 'x1.csv'), 
            path.join('req-test', 'ld_containers', 'myctnr-test', 'x2.csv'),
            path.join('req-test', 'ld_containers', 'myctnr-test', 'scripts', 'test.r'),
            path.join('req-test', 'ld_containers', 'myctnr-test', 'img', 'daftpunk.jpg'),
            path.join('req-test', 'ld_containers', 'myctnr-test', 'README.md'),
            path.join('req-test', 'ld_resources', 'azerty.csv'),
            path.join('req-test', 'container.jsonld'),
            path.join('req-test', 'README.md')
          ];

          assert(files.length && difference(files, expected).length === 0);
          done();
        });
      });
    });

    it('should install myctnr-test at the top level with all env files', function(done){
      temp.mkdir('test-ldc-', function(err, dirPath) {
        var ldc = new Ldc(conf, dirPath);
        ldc.install(['myctnr-test@0.0.0'], { top: true, env:true }, function(err, ctnrs){          
          var files = readdirpSync(path.join(dirPath, 'myctnr-test'));
          var expected = ['container.jsonld',  'env.txt'];
          assert(files.length && difference(files, expected).length === 0);
          done();
        });
      });
    });    

    it('should install myctnr-test@0.0.0 at the top level, cache data and put inlined data in their own files in ld_resources', function(done){
      temp.mkdir('test-ldc-', function(err, dirPath) {
        var ldc = new Ldc(conf, dirPath);
        ldc.install(['myctnr-test@0.0.0'], {top: true, cache: true, require: true}, function(err){
          var files = readdirpSync(path.join(dirPath, 'myctnr-test'));

          console.log(files);
          var expected = [ 
            'container.jsonld', 
            'x1.csv', 
            'x2.csv',
            path.join('scripts', 'test.r'),
            path.join('img', 'daftpunk.jpg'),
            path.join('ld_resources', 'inline.json'),
            'README.md'
          ];

          assert(files.length && difference(files, expected).length === 0);
          done();
        });
      });
    });

    after(function(done){
      rmFixtures(done);
    });
    
  });


  describe('code bundles', function(){

    before(function(done){
      var ldc = new Ldc(conf, path.join(root, 'fixtures', 'init-test'));
      ldc.adduser(function(err, headers){
        ldc.paths2resources(['*.csv'], {codeBundles: ['scripts']}, function(err, resources){
          var ctnr = {name: 'test-bundle', version: '0.0.0'};
          ldc.addResources(ctnr, resources);
          fs.writeFileSync(path.join(root, 'fixtures', 'init-test', 'container.jsonld'), JSON.stringify(ctnr, null, 2));
          ldc.publish(function(err, body){                     
            done();
          });       
        });     
      });     
    });

    it('should properly unpack a codebundle', function(done){

      temp.mkdir('test-ldc-', function(err, dirPath) {
        var ldc = new Ldc(conf, dirPath);
        ldc.install(['test-bundle@0.0.0'], { top: true, cache: true }, function(err){
          var files = readdirpSync(path.join(dirPath, 'test-bundle'));

          var expected = [ 
            path.join('scripts', 'main.r'),
            path.join('scripts', 'deps', 'dep.r'),
            'x1.csv',
            'container.jsonld',
            'README.md'
          ];
          
          assert(files.length && difference(files, expected).length === 0);
          done();
        });
      });

    });

    after(function(done){
      fs.unlinkSync(path.join(root, 'fixtures', 'init-test', 'container.jsonld'));
      request.del( { url: rurl('/test-bundle'), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
        request.del( { url: rurl('/rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
          done();
        });
      });
    });
  });

});
