var util = require('util')
  , fs = require('fs')
  , clone = require('clone')
  , temp = require('temp')
  , assert = require('assert')
  , request = require('request')
  , Ldpm = require('..')
  , readdirpSync = require('fs-readdir-recursive')
  , _ = require('underscore')
  , exec = require('child_process').exec
  , path = require('path');

temp.track();

//!!!!!! NOTE: all the tests assume that only the proxy of the linked data registry is running, not the post-publish addition....

var root = path.dirname(__filename);

describe('ldpm', function(){
  this.timeout(20000);

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

  function rmFixtures (cb){
    request.del( { url: rurl('/mypkg-test'), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
      request.del( { url: rurl('/req-test'), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
        request.del( { url: rurl('/rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
          request.del( { url: rurl('/rmuser/user_b'), auth: {user: 'user_b', pass: conf.password} }, function(err, resp, body){
            cb();
          });
        });
      });
    });
  };

  describe('init', function(){

    var expected = {
      description: 'my package description',
      license: 'CC0-1.0',
      dataset: [
        { name: 'x1',
          distribution: { contentPath: 'x1.csv', encodingFormat: 'text/csv' },
          about: [ { name: 'a', valueType: 'xsd:integer' }, { name: 'b', valueType: 'xsd:integer' } ]
        }
      ],
      code: [
        {
          name: 'C',
          targetProduct: {
            //filePath: '/var/folders/7p/587xptpx31d0l7rbb1cxk5y80000gn/T/ldpm-114127-1835-la1g41', always different
            bundlePath: 'C',
            fileFormat: 'application/x-gzip'
          }
        },
        {
          name: 'scripts',
          targetProduct: {
            //filePath: '/var/folders/7p/587xptpx31d0l7rbb1cxk5y80000gn/T/ldpm-114127-1835-7ba56z',
            bundlePath: 'scripts',
            fileFormat: 'application/x-gzip'
          }
        }
      ]
    };

    it('should create a package.jsonld with default values and code bundles', function(done){
      exec(path.join(path.dirname(root), 'bin', 'ldpm') + ' init "*.csv" -b C -b scripts --defaults', {cwd: path.join(root, 'fixtures', 'init-test') }, function(err, stdout, stderr){
        var pkg = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'init-test', 'package.jsonld'), 'utf8'));

        delete pkg.author; //might not be here
        assert(pkg.code[0].targetProduct.filePath);
        assert(pkg.code[1].targetProduct.filePath);
        delete pkg.code[0].targetProduct.filePath;
        delete pkg.code[1].targetProduct.filePath;
        assert.deepEqual(pkg, expected);
        done();
      });
    });

    it('should create a package.jsonld with default values and do not include content of node_modules or package.jsonld in case we ask to recursively include everything', function(done){
      exec(path.join(path.dirname(root), 'bin', 'ldpm') + ' init "**/*" -b C -b scripts --defaults', {cwd: path.join(root, 'fixtures', 'init-test') }, function(err, stdout, stderr){
        var pkg = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'init-test', 'package.jsonld'), 'utf8'));

        delete pkg.author;
        delete pkg.code[0].targetProduct.filePath;
        delete pkg.code[1].targetProduct.filePath;

        var exp = clone(expected);
        exp.article = [{
          name: 'pone',
          encoding: { contentPath: 'pone.pdf', encodingFormat: 'application/pdf' }
        }];

        assert.deepEqual(pkg, exp);
        done();
      });
    });

  });


  describe('adduser', function(){
    var ldpm;

    before(function(done){
      ldpm = new Ldpm(conf, path.join(root, 'fixtures', 'mypkg-test'));
      ldpm.adduser(function(err, auth){
        done()
      });
    });


    it('should return auth token if user already registered but adduser is called with correct username and password', function(done){
      ldpm.adduser(function(err, auth){
        assert(auth.name, conf.name);
        done()
      });
    });


    it('should err if already registered user adduser with same name but invalid password', function(done){
      var myc = clone(conf);
      myc.password = 'wrong'
      var wrong = new Ldpm(myc, path.join(root, 'fixtures', 'mypkg-test'));
      wrong.adduser(function(err, auth){
        assert(err.message, '․invalid password for user: user_a');
        done()
      });
    });

    after(function(done){
      request.del( { url: rurl('/rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
        done();
      })
    });

  });


  describe('publish', function(){
    var ldpm1, ldpm2;

    before(function(done){
      ldpm1 = new Ldpm(conf, path.join(root, 'fixtures', 'mypkg-test'));
      ldpm2 = new Ldpm(conf, path.join(root, 'fixtures', 'req-test'));

      ldpm1.adduser(function(err, headers){
        done()
      });
    });

    it('should publish a package with attachments and raise an error with code if the pkg is republished', function(done){
      ldpm1.publish(function(err, id){
        if(err) throw err;
        assert.equal('mypkg-test@0.0.0', id);
        ldpm1.publish(function(err, id){
          assert.equal(err.code, 409);
          done();
        });
      });
    });

    it('should publish a package without attachments', function(done){
      ldpm2.publish(function(err, id){
        assert.equal('req-test@0.0.0', id);
        done();
      });
    });

    after(function(done){
      rmFixtures(done);
    });

  });


  describe('unpublish', function(){
    var ldpm1;

    before(function(done){
      ldpm1 = new Ldpm(conf, path.join(root, 'fixtures', 'mypkg-test'));
      ldpm1.adduser(function(err, headers){
        ldpm1.publish(function(err, id){
          done();
        })
      });
    });

    it('should unpublish a pkg', function(done){
      ldpm1.unpublish('mypkg-test', function(err, res){
        assert.deepEqual(res, {ok:true});
        done();
      });
    });

    after(function(done){
      rmFixtures(done);
    });

  });


  describe('owner', function(){

    var expected = [
      {name: 'user_a', email: 'user@domain.com'},
      {name: 'user_b', email: 'user@domain.com'}
    ];

    var ldpm1, ldpm2;
    before(function(done){
      ldpm1 = new Ldpm(conf, path.join(root, 'fixtures', 'req-test'));
      var conf2 = clone(conf);
      conf2.name = 'user_b';
      ldpm2 = new Ldpm(conf2, path.join(root, 'fixtures', 'req-test'));

      ldpm1.adduser(function(err, headers){
        ldpm2.adduser(function(err, id){
          ldpm1.publish(function(err, body){
            done();
          });
        });
      });
    });

    it('should list the maintainers', function(done){
      ldpm1.lsOwner('req-test', function(err, maintainers){
        assert.deepEqual(maintainers, expected.slice(0, 1));
        done();
      });
    });

    it('should add a maintainer then remove it', function(done){
      ldpm1.addOwner({username: 'user_b', pkgname: 'req-test'}, function(err){
        ldpm1.lsOwner('req-test', function(err, maintainers){
          assert.deepEqual(maintainers, expected);
          ldpm1.rmOwner({username: 'user_b', pkgname: 'req-test'}, function(err){
            ldpm1.lsOwner('req-test', function(err, maintainers){
              assert.deepEqual(maintainers, expected.slice(0, 1));
              done();
            });
          });
        });
      });
    });

    it("should err", function(done){
      ldpm1.addOwner({username: 'user_c', pkgname: 'req-test'}, function(err){
        assert.equal(err.code, 404);
        done();
      })
    });

    after(function(done){
      rmFixtures(done);
    });

  });

  describe('cat', function(){

    var ldpm1, ldpm2;

    var expected = {
//      '@context': 'http://localhost:3000/package.jsonld',
      '@id': 'req-test/0.0.0',
      '@type': ['Package', 'DataCatalog'],
      name: 'req-test',
      description: 'a test for data dependencies',
      isBasedOnUrl: [ 'mypkg-test/0.0.0' ],
      version: '0.0.0',
      keywords: [ 'test', 'package' ],
      dataset: [
        {
          '@id': 'req-test/0.0.0/dataset/azerty',
          '@type': 'Dataset',
          name: 'azerty',
          distribution:  {
            '@type': 'DataDownload' ,
            contentUrl: 'r/f9b634be34cb3f2af4fbf4395e3f24b3834da926',
          },
          catalog: { '@type': ['Package', 'DataCatalog'], name: 'req-test', version: '0.0.0', url: 'req-test/0.0.0' }
        }
      ],
      registry: { name: 'Standard Analytics IO', url: 'https://registry.standardanalytics.io/' }
    };

    before(function(done){
      ldpm1 = new Ldpm(conf, path.join(root, 'fixtures', 'mypkg-test'));
      ldpm2 = new Ldpm(conf, path.join(root, 'fixtures', 'req-test'));

      ldpm1.adduser(function(err, headers){
        ldpm1.publish(function(err, id){
          ldpm2.publish(function(err, body){
            done();
          });
        });
      });
    });

    it('should error if we cat unexisting pkg', function(done){
      ldpm2.cat('reqxddwdwdw@0.0.0', function(err, pkg){
        assert.equal(err.code, 404);
        done();
      });
    });

    it('should cat the pkg as JSON-LD', function(done){
      ldpm2.cat('req-test@0.0.0', function(err, pkg){
        assert('@context' in pkg);
        delete pkg['@context'];
        assert.deepEqual(expected, pkg);
        done();
      });
    });

    it('should cat the latest pkg when version is not specified', function(done){
      ldpm2.cat('req-test', function(err, pkg){
        assert.equal(expected.version, pkg.version);
        done();
      });
    });

    after(function(done){
      rmFixtures(done);
    });

  });

  describe('files', function(){
    var ldpm1, ldpm2;
    before(function(done){
      ldpm1 = new Ldpm(conf, path.join(root, 'fixtures', 'req-test'));
      ldpm1.adduser(function(err, headers){
        ldpm1.publish(function(err, body){
          ldpm2 = new Ldpm(conf, path.join(root, 'fixtures', 'mypkg-test'));
          ldpm2.publish(function(err, body){
            done();
          });
        });
      });
    });

    it('should install req-test@0.0.0 (and its dependencies) at the top level and cache data', function(done){
      temp.mkdir('test-ldpm-', function(err, dirPath) {
        var ldpm = new Ldpm(conf, dirPath);
        ldpm.install(['req-test@0.0.0'], {top: true, cache: true}, function(err){
          var files = readdirpSync(path.join(dirPath, 'req-test'));

          var expected = [
            path.join('ld_packages', 'mypkg-test', 'package.jsonld'),
            path.join('ld_packages', 'mypkg-test', 'x1.csv'),
            path.join('ld_packages', 'mypkg-test', 'x2.csv'),
            path.join('ld_packages', 'mypkg-test', 'scripts', 'test.r'),
            path.join('ld_packages', 'mypkg-test', 'img', 'daftpunk.jpg'),
            path.join('ld_packages', 'mypkg-test', 'article', 'pone.pdf'),
            path.join('ld_packages', 'mypkg-test', 'README.md'),
            path.join('ld_resources', 'azerty.csv'),
            'package.jsonld',
            'README.md'
          ];

          assert(files.length && _.difference(files, expected).length === 0);
          done();
        });
      });
    });


    it('should install req-test@0.0.0 (and its dependencies) and cache data', function(done){
      temp.mkdir('test-ldpm-', function(err, dirPath) {
        var ldpm = new Ldpm(conf, dirPath);
        ldpm.install(['req-test@0.0.0'], {cache: true}, function(err){
          var files = readdirpSync(path.join(dirPath, 'ld_packages'));

          var expected = [
            path.join('req-test', 'ld_packages', 'mypkg-test', 'package.jsonld'),
            path.join('req-test', 'ld_packages', 'mypkg-test', 'x1.csv'),
            path.join('req-test', 'ld_packages', 'mypkg-test', 'x2.csv'),
            path.join('req-test', 'ld_packages', 'mypkg-test', 'scripts', 'test.r'),
            path.join('req-test', 'ld_packages', 'mypkg-test', 'img', 'daftpunk.jpg'),
            path.join('req-test', 'ld_packages', 'mypkg-test', 'article', 'pone.pdf'),
            path.join('req-test', 'ld_packages', 'mypkg-test', 'README.md'),
            path.join('req-test', 'ld_resources', 'azerty.csv'),
            path.join('req-test', 'package.jsonld'),
            path.join('req-test', 'README.md')
          ];

          assert(files.length && _.difference(files, expected).length === 0);
          done();
        });
      });
    });


    it('should install mypkg-test@0.0.0 at the top level, cache data and put inlined data in their own files in ld_resources', function(done){
      temp.mkdir('test-ldpm-', function(err, dirPath) {
        var ldpm = new Ldpm(conf, dirPath);
        ldpm.install(['mypkg-test@0.0.0'], {top: true, cache: true, require: true}, function(err){
          var files = readdirpSync(path.join(dirPath, 'mypkg-test'));

          var expected = [
            'package.jsonld',
            'x1.csv',
            'x2.csv',
            path.join('scripts', 'test.r'),
            path.join('img', 'daftpunk.jpg'),
            path.join('article', 'pone.pdf'),
            path.join('ld_resources', 'inline.json'),
            'README.md'
          ];

          assert(files.length && _.difference(files, expected).length === 0);
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
      var ldpm = new Ldpm(conf, path.join(root, 'fixtures', 'init-test'));
      ldpm.adduser(function(err, headers){
        ldpm.paths2resources(['*.csv'], {codeBundles: ['scripts']}, function(err, resources){
          var pkg = {name: 'test-bundle', version: '0.0.0'};
          ldpm.addResources(pkg, resources);
          fs.writeFileSync(path.join(root, 'fixtures', 'init-test', 'package.jsonld'), JSON.stringify(pkg, null, 2));
          ldpm.publish(function(err, body){
            done();
          });
        });
      });
    });

    it('should properly unpack a codebundle', function(done){

      temp.mkdir('test-ldpm-', function(err, dirPath) {
        var ldpm = new Ldpm(conf, dirPath);
        ldpm.install(['test-bundle@0.0.0'], { top: true, cache: true }, function(err){
          var files = readdirpSync(path.join(dirPath, 'test-bundle'));

          var expected = [
            path.join('scripts', 'main.r'),
            path.join('scripts', 'deps', 'dep.r'),
            'x1.csv',
            'package.jsonld',
            'README.md'
          ];

          assert(files.length && _.difference(files, expected).length === 0);
          done();
        });
      });

    });

    after(function(done){
      fs.unlinkSync(path.join(root, 'fixtures', 'init-test', 'package.jsonld'));
      request.del( { url: rurl('/test-bundle'), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
        request.del( { url: rurl('/rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
          done();
        });
      });
    });
  });

});
