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



function getPkg(pmcid, callback){
  temp.mkdir('__tests',function(err, dirPath) {
    if(err) throw err;
    var ldpm = new Ldpm(conf, dirPath);
    
    var tgzStream = fs.createReadStream(path.join(root, pmcid.toLowerCase() + '.tar.gz'))
      .pipe(zlib.Unzip())
      .pipe(tar.Extract({ path: dirPath, strip: 1 }));
    
    tgzStream.on('end', function() {
      oapmc.getPkg(pmcid, ldpm, dirPath, callback);
    });
  });
};


describe('pubmed central', function(){

  this.timeout(320000);

  //http://www.pubmedcentral.nih.gov/oai/oai.cgi?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:2924383&metadataPrefix=pmc
  it('should create a package.jsonld for a ms with a movie zipped and not treat it as a code bundle', function(done){
    getPkg('PMC2924383', function(err, pkg){
      if(err) throw err;
      console.log(util.inspect(pkg, {depth: null}));      
      done();
    });
  });
});
