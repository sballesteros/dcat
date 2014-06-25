var path = require('path')
  , util = require('util')
  , tar = require('tar')
  , zlib = require('zlib')
  , assert = require('assert')
  , fs = require('fs')
  , temp = require('temp')
  , Ldpm = require('..')
  , oapmc = require('../plugin/oapmc');

temp.track();

var root = path.join(path.dirname(__filename), 'fixtures', 'oapmc');

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

function getPkg(pmcid, pmid, callback){
  if(arguments.length === 2){
    callback = pmid;
    pmid = undefined;
  }

  temp.mkdir('__tests',function(err, dirPath) {
    if(err) throw err;
    var ldpm = new Ldpm(conf, dirPath);
    
    var tgzStream = fs.createReadStream(path.join(root, pmcid.toLowerCase() + '.tar.gz'))
      .pipe(zlib.Unzip())
      .pipe(tar.Extract({ path: dirPath, strip: 1 }));
    
    tgzStream.on('end', function() {
      oapmc.getPkg(pmcid, ldpm, dirPath, {pmid: pmid}, callback);
    });
  });
};

describe('pubmed central', function(){

  //http://www.pubmedcentral.nih.gov/oai/oai.cgi?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:2924383&metadataPrefix=pmc
  it('should create a package.jsonld for a ms with a movie zipped and not treat it as a code bundle AND add pubmed annotation', function(done){
    getPkg('PMC2924383', function(err, pkg){
      if(err) throw err;
      fs.writeFileSync(path.join(root, 'pmc2924383.json'), JSON.stringify(pkg, null, 2));
      fs.readFile(path.join(root, 'pmc2924383.json'), function(err, expected){
        if(err) throw err;
        assert.deepEqual(JSON.parse(JSON.stringify(pkg)), JSON.parse(expected)); //JSON.parse(JSON.stringify) so that NaN are taken into account...
        done();
      });
    });
  });

  it('should create a package.jsonld for a ms with a lot of inline formulaes', function(done){
    getPkg('PMC2958805', 20975938, function(err, pkg){
      if(err) throw err;
      //fs.writeFileSync(path.join(root, 'pmc2958805.json'), JSON.stringify(pkg, null, 2));
      fs.readFile(path.join(root, 'pmc2958805.json'), function(err, expected){
        if(err) throw err;
        assert.deepEqual(JSON.parse(JSON.stringify(pkg)), JSON.parse(expected)); //JSON.parse(JSON.stringify) so that NaN are taken into account...
        done();
      });
    });
  });

  it('should create a package.jsonld for a ms with a codeBundle and an HTML table with footnotes', function(done){
    getPkg('PMC3532326', function(err, pkg){
      if(err) throw err;      
      //fs.writeFileSync(path.join(root, 'pmc3532326.json'), JSON.stringify(pkg, null, 2));
      fs.readFile(path.join(root, 'pmc3532326.json'), function(err, expected){
        if(err) throw err;
        pkg = JSON.parse(JSON.stringify(pkg));
        var expected = JSON.parse(expected);
        delete pkg.code[0].targetProduct[0].filePath;
        delete expected.code[0].targetProduct[0].filePath;
        assert.deepEqual(pkg, expected);
        done();
      });
    });
  });

});
