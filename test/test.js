var util = require('util')
  , fs = require('fs')
  , clone = require('clone')
  , temp = require('temp')
  , assert = require('assert')
  , request = require('request')
  , Ldpm = require('..')
  , readdirpSync = require('fs-readdir-recursive')
  , difference = require('lodash.difference')
  , exec = require('child_process').exec
  , path = require('path');

temp.track();

var root = path.dirname(__filename);

describe('ldpm', function(){
  this.timeout(8000);

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
    request.del( { url: rurl('/mydpkg-test'), auth: {user: conf.name, pass: conf.password} }, function(err, resp, body){
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

    it('should create a datapackage.json with default values', function(done){
      var expected = {
        license: 'CC0-1.0',
        description: 'my datapackage description',
        dataset: [
          {
            name: 'x1',
            distribution: { 
              '@context': {
                xsd: 'http://www.w3.org/2001/XMLSchema#',
                a: { '@id': '_:a', '@type': 'xsd:integer' },
                b: { '@id': '_:b', '@type': 'xsd:integer' }
              },
              contentPath: 'x1.csv',
              encodingFormat: 'csv' 
            }
          }
        ]
      };
      
      exec(path.join(path.dirname(root), 'bin', 'ldpm') + ' init *.csv --defaults', {cwd: path.join(root, 'fixtures', 'init-test') }, function(err, stdout, stderr){
        var dpkg = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'init-test', 'datapackage.json'), 'utf8'));
        delete dpkg.author;
        assert.deepEqual(dpkg, expected);
        done();
      });
    });

  });

  describe('publish', function(){
    var ldpm1, ldpm2;

    before(function(done){
      ldpm1 = new Ldpm(conf, path.join(root, 'fixtures', 'mydpkg-test'));
      ldpm2 = new Ldpm(conf, path.join(root, 'fixtures', 'req-test'));

      ldpm1.adduser(function(err, headers){
        done()
      });
    });
    
    it('should publish a data package with attachments and raise an error with code if the dpkg is republished', function(done){
      ldpm1.publish(function(err, id){
        assert.equal('mydpkg-test@0.0.0', id);
        ldpm1.publish(function(err, id){     
          assert.equal(err.code, 409);
          done();
        });
      });
    });

    it('should publish a data package without attachments', function(done){
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
      ldpm1 = new Ldpm(conf, path.join(root, 'fixtures', 'mydpkg-test'));
      ldpm1.adduser(function(err, headers){
        ldpm1.publish(function(err, id){
          done();
        })
      });
    });
    
    it('should unpublish a dpkg', function(done){
      ldpm1.unpublish('mydpkg-test', function(err, res){
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
      ldpm1.addOwner({username: 'user_b', dpkgName: 'req-test'}, function(err){
        ldpm1.lsOwner('req-test', function(err, maintainers){
          assert.deepEqual(maintainers, expected);
          ldpm1.rmOwner({username: 'user_b', dpkgName: 'req-test'}, function(err){
            ldpm1.lsOwner('req-test', function(err, maintainers){
              assert.deepEqual(maintainers, expected.slice(0, 1));
              done();
            });
          });
        });
      });
    });

    it("should err", function(done){
      ldpm1.addOwner({username: 'user_c', dpkgName: 'req-test'}, function(err){
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
//      '@context': 'http://localhost:3000/contexts/datapackage.jsonld',
      '@id': 'req-test/0.0.0',
      '@type': 'DataCatalog',
      name: 'req-test',
      description: 'a test for data dependencies',
      about: { name: 'README.md', url: 'req-test/0.0.0/about/README.md' },
      isBasedOnUrl: [ 'mydpkg-test/0.0.0' ],
      version: '0.0.0',
      keywords: [ 'test', 'datapackage' ],
      dataset: [
        {
          '@id': 'req-test/0.0.0/dataset/azerty',
          '@type': 'Dataset',
          name: 'azerty',
          fields: [ 'a' ],
          distribution:  {
            '@type': 'DataDownload' ,
            contentUrl: 'mydpkg-test/0.0.0/dataset/csv1/x1.csv',
            //uploadDate: '2014-01-12T05:11:48.221Z',
          },
          catalog: { name: 'req-test', version: '0.0.0', url: 'req-test/0.0.0' } 
        }
      ],
//      datePublished: '2014-01-12T05:11:48.220Z',
      encoding: {
        contentUrl: 'req-test/0.0.0/dist_/dist_.tar.gz',
        contentSize: 29,
        encodingFormat: 'gtar',
        hashAlgorithm: 'md5',
        hashValue: '31f6566d35ccd604be46ed5b1f813cdf' 
      },
      catalog: { name: 'req-test', url: 'req-test' }
    };

    before(function(done){
      ldpm1 = new Ldpm(conf, path.join(root, 'fixtures', 'mydpkg-test'));
      ldpm2 = new Ldpm(conf, path.join(root, 'fixtures', 'req-test'));

      ldpm1.adduser(function(err, headers){
        ldpm1.publish(function(err, id){
          ldpm2.publish(function(err, body){
            done();
          });
        });
      });
    });

    it('should error if we cat unexisting dpkg', function(done){
      ldpm2.cat('reqxddwdwdw@0.0.0', function(err, dpkg){
        assert.equal(err.code, 404);
        done();
      });
    });

    it('should cat the dpkg as JSON-LD', function(done){
      ldpm2.cat('req-test@0.0.0', function(err, dpkg){
        assert('@context' in dpkg);
        delete dpkg['@context'];
        assert('datePublished' in dpkg);
        delete dpkg.datePublished;
        assert('uploadDate' in dpkg.dataset[0].distribution);
        delete dpkg.dataset[0].distribution.uploadDate;
        assert.deepEqual(expected, dpkg);
        done();
      });
    });

    it('should cat the latest dpkg when version is not specified', function(done){
      ldpm2.cat('req-test', function(err, dpkg){
        assert.equal(expected.version, dpkg.version);
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
          ldpm2 = new Ldpm(conf, path.join(root, 'fixtures', 'mydpkg-test'));
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
            path.join('datapackages', 'mydpkg-test', 'datapackage.json'), 
            path.join('datapackages', 'mydpkg-test', 'x1.csv'), 
            path.join('datapackages', 'mydpkg-test', 'x2.csv'),
            path.join('datapackages', 'mydpkg-test', 'README.md'),
            'datapackage.json',
            'README.md'
          ];

          assert(files.length && difference(files, expected).length === 0);
          done();
        });
      });
    });

    it('should install req-test@0.0.0 (and its dependencies) and cache data', function(done){
      temp.mkdir('test-ldpm-', function(err, dirPath) {
        var ldpm = new Ldpm(conf, dirPath);
        ldpm.install(['req-test@0.0.0'], {cache: true}, function(err){
          var files = readdirpSync(path.join(dirPath, 'datapackages'));

          var expected = [ 
            path.join('req-test', 'datapackages', 'mydpkg-test', 'datapackage.json'), 
            path.join('req-test', 'datapackages', 'mydpkg-test', 'x1.csv'), 
            path.join('req-test', 'datapackages', 'mydpkg-test', 'x2.csv'),
            path.join('req-test', 'datapackages', 'mydpkg-test', 'README.md'),
            path.join('req-test', 'datapackage.json'),
            path.join('req-test', 'README.md')
          ];

          assert(files.length && difference(files, expected).length === 0);
          done();
        });
      });
    });

    it('should install mydpkg-test at the top level with all the script files', function(done){
      temp.mkdir('test-ldpm-', function(err, dirPath) {
        var ldpm = new Ldpm(conf, dirPath);
        ldpm.install(['mydpkg-test@0.0.0'], { top: true, all:true }, function(err, dpkgs){          
          var files = readdirpSync(path.join(dirPath, 'mydpkg-test'));
          assert(files.length && difference(files, ['datapackage.json', 'README.md', path.join('scripts', 'test.r')]).length === 0);
          done();
        });
      });
    });
    
    after(function(done){
      rmFixtures(done);
    });
    
  });

});
