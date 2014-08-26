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
  , SaSchemaOrg = require('sa-schema-org')
  , path = require('path');

temp.track();

var root = path.dirname(__filename);

var conf = {
  protocol: 'http:',
  port: 3000,
  hostname: 'localhost',
  strictSSL: false,
  sha:true,
  name: "user_a",
  email: "user@domain.com",
  password: "user_a"
};

function rurl(path){
  return conf.protocol + '//' + conf.hostname + ((conf.port !== 80) ? ':' + conf.port: '') + '/' + path;
};

describe('ldpm', function(){
  this.timeout(100000);

  describe('addUser', function(){
    var ldpm = new Ldpm(conf);

    before(function(done){
      ldpm.addUser(done);
    });

    it('should return auth token if user already registered but addUser is called with correct username and password', function(done){
      ldpm.addUser(function(err, auth){
        assert(auth.name, conf.name);
        done()
      });
    });

    it('should err if already registered user addUser with same name but invalid password', function(done){
      var myc = clone(conf); myc.password = 'wrong'
      var ldpmWrong = new Ldpm(myc);
      ldpmWrong.addUser(function(err, auth){
        assert(err.message, '․invalid password for user: user_a');
        done()
      });
    });

    after(function(done){
      request.del({ url: rurl('rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, done);
    });

  });

  describe('paths and URLs to resources', function(){
    var ldpm = new Ldpm(conf, path.join(root, 'fixtures', 'cw-test'));
    it('should convert paths to resources', function(done){
      ldpm.wrap(['**/*.csv', {id:'src', type:'Code'}], function(err, resources){

        var expected = [
          {
            '@id': 'data',
            '@type': 'Dataset',
            distribution: {
              '@type': 'DataDownload',
              filePath: 'data.csv',
              contentSize: 16,
              //dateModified: '2014-06-16T13:38:20.000Z',
              encodingFormat: 'text/csv'
            }
          },
          {
            '@id': 'src',
            '@type': 'Code',
            programmingLanguage: { name: 'c' },
            encoding: {
              '@type': 'MediaObject',
              //dateModified: '2014-06-16T13:38:20.000Z',
              encodingFormat: 'application/x-gtar',
              hasPart: [
                { '@type': 'MediaObject', filePath: 'src/lib.h', contentSize: 18, /*dateModified: '2014-06-16T13:38:20.000Z'*/ },
                { '@type': 'MediaObject', filePath: 'src/main.c', contentSize: 17, /*dateModified: '2014-06-16T13:38:20.000Z'*/ }
              ]
            }
          }
        ];
        resources.sort(function(a,b){return a['@id'].localeCompare(b['@id']);});
        assert('dateModified' in resources[0].distribution);
        assert('dateModified' in resources[1].encoding);
        resources[1].encoding.hasPart.forEach(function(p){
          assert('dateModified' in p);
          delete p.dateModified;
        });
        delete resources[0].distribution.dateModified;
        delete resources[1].encoding.dateModified;
        assert.deepEqual(resources, expected);
        done();
      });
    });

    it('should convert URLs to resources', function(done){
      ldpm.wrap("https://github.com/standard-analytics/ldpm.git", function(err, resources){
        if(err) console.error(err);
        var expected = [{
          '@id': 'ldpm',
          '@type': 'Code',
          codeRepository: 'https://github.com/standard-analytics/ldpm',
          encoding:  {
            '@type': 'MediaObject',
            contentUrl: 'https://api.github.com/repos/standard-analytics/ldpm/tarball/master',
            encodingFormat: 'application/x-gzip',
            //contentSize: 690980
          }
        }];
        delete resources[0].encoding.contentSize;
        assert.deepEqual(resources, expected);
        done();
      });
    });

  });

  describe('publish', function(){
    var ldpm;
    before(function(done){
      ldpm = new Ldpm(conf, path.join(root, 'fixtures', 'cw-test'));
      ldpm.addUser(done);
    });

    it('should get mnodes', function(done){
      ldpm.cdoc(function(err, cdoc){
        var expected =  [
          { node: { hasPart: [ { filePath: 'src/lib.h' }, { filePath: 'src/main.c' } ] }, type: 'MediaObject' },
          { node: { filePath: 'article/pone.pdf' }, type: 'MediaObject' },
          { node: { filePath: 'img/daftpunk.jpg' }, type: 'MediaObject' },
          { node: { '@id': 'sa:cw-test/app', '@type': 'SoftwareApplication', filePath: 'app/app.zip' }, type: 'SoftwareApplication' },
          { node: { filePath: 'data.csv' }, type: 'DataDownload' }
        ];

        assert.deepEqual(ldpm._mnodes(cdoc), expected);
        done();
      });
    });

    it('should publish a document', function(done){
      ldpm.publish(function(err, body, statusCode){
        assert.equal(statusCode, 201);
        done();
      });
    });

    after(function(done){
      ldpm.unpublish('cw-test', function(){
        request.del({ url: rurl('rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, done);
      });
    });

  });

  describe('cat', function(){
    var ldpm;
    before(function(done){
      var doc = {
        '@context': SaSchemaOrg.contextUrl,
        '@id': 'cat-test',
        name:'cat'
      };

      ldpm = new Ldpm(conf);
      ldpm.addUser(function(){
        ldpm.publish(doc, done);
      });
    });

    it('should cat a document as compacted JSON-LD', function(done){
      ldpm.cat('cat-test', function(err, doc){
        assert.deepEqual(doc, { '@context': SaSchemaOrg.contextUrl, '@id': 'sa:cat-test', name: 'cat' });
        done();
      });
    });

    it('should cat a document as flattened JSON-LD', function(done){
      ldpm.cat('cat-test', {profile:'flattened'}, function(err, doc){
        assert.deepEqual(doc, { '@context': SaSchemaOrg.contextUrl, '@graph': [ { '@id': 'sa:cat-test', name: 'cat' } ] });
        done();
      });
    });

    it('should cat a document as expanded JSON-LD', function(done){
      ldpm.cat('cat-test', {profile:'expanded'}, function(err, doc){
        assert.deepEqual(doc, [ { '@id': 'https://registry.standardanalytics.io/cat-test', 'http://schema.org/name': [ { '@value': 'cat' } ] } ]);
        done();
      });
    });

    it('should cat a document as normalized JSON-LD', function(done){
      ldpm.cat('cat-test', {normalize: true}, function(err, doc){
        assert.equal(doc, '<https://registry.standardanalytics.io/cat-test> <http://schema.org/name> "cat" .\n');
        done();
      });
    });

    it('should error if we cat unexisting pkg', function(done){
      ldpm.cat('reqxddwdwdw', function(err, doc){
        assert.equal(err.code, 404);
        done();
      });
    });

    after(function(done){
      ldpm.unpublish('cat-test', function(){
        request.del({ url: rurl('rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, done);
      });
    });
  });


  describe('clone', function(){
    var ldpm;
    before(function(done){
      ldpm = new Ldpm(conf, path.join(root, 'fixtures', 'cw-test'));
      ldpm.addUser(function(){
        ldpm.publish(done);
      });
    });

    it('should clone a document', function(done){
      temp.mkdir('test-ldpm-', function(err, dirPath) {
        ldpm = new Ldpm(conf, dirPath);
        ldpm.clone('cw-test', {force: true}, function(err, doc){
          var files = readdirpSync(path.join(dirPath, 'localhost', 'cw-test'));
          var expected =  [
            'JSONLD',
            'app/app.zip',
            'article/pone.pdf',
            'data.csv',
            'img/daftpunk.jpg',
            'src/lib.h',
            'src/main.c'
          ];
          assert(files.length && _.difference(files, expected).length === 0);
          done();
        });
      });
    });

    after(function(done){
      ldpm.unpublish('cw-test', function(){
        request.del({ url: rurl('rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, done);
      });
    });
  });


  describe('maintainers', function(){

    var accountablePersons =  [
      { '@type': 'Person', name: 'user_a', email: 'mailto:user@domain.com' },
      { '@type': 'Person', name: 'user_b', email: 'mailto:user@domain.com' }
    ];

    var doc = { '@context': SaSchemaOrg.contextUrl, '@id': 'maintainer-test', name:'maintainer' };
    var conf2 = clone(conf);
    conf2.name = 'user_b';
    var ldpm1 = new Ldpm(conf);
    var ldpm2 = new Ldpm(conf2);

    before(function(done){
      ldpm1.addUser(function(err, body){
        ldpm2.addUser(function(err, body){
          ldpm1.publish(doc, function(err, body){
            done();
          });
        });
      });
    });

    it('should list the maintainers', function(done){
      ldpm1.lsMaintainer(doc['@id'], function(err, body){
        assert.deepEqual(body.accountablePerson, accountablePersons.slice(0, 1));
        done();
      });
    });

    it('should add a maintainer then remove it', function(done){
      ldpm1.addMaintainer({username: 'user_b', namespace: doc['@id']}, function(err){
        ldpm1.lsMaintainer(doc['@id'], function(err, maintainers){
          assert.deepEqual(maintainers.accountablePerson, accountablePersons);
          ldpm1.rmMaintainer({username: 'user_b', namespace: doc['@id']}, function(err){
            ldpm1.lsMaintainer(doc['@id'], function(err, maintainers){
              assert.deepEqual(maintainers.accountablePerson, accountablePersons.slice(0, 1));
              done();
            });
          });
        });
      });
    });

    it("should err if a non registered user is added as a maintainer", function(done){
      ldpm1.addMaintainer({username: 'user_c', namespace: doc['@id']}, function(err){
        assert.equal(err.code, 404);
        done();
      })
    });

    after(function(done){
      ldpm1.unpublish(doc['@id'], function(){
        request.del({ url: rurl('rmuser/' + conf.name), auth: {user: conf.name, pass: conf.password} }, function(){
          request.del({ url: rurl('rmuser/' + conf2.name), auth: {user: conf2.name, pass: conf2.password} }, done);
        });
      });
    });

  });

});
