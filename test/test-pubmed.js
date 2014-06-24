var path = require('path')
  , util = require('util')
  , assert = require('assert')
  , fs = require('fs')
  , pubmed = require('../plugin/pubmed');

var root = path.join(path.dirname(__filename), 'fixtures', 'pubmed');

describe('pubmed', function(){

  it('should parse a pubmed entry with MeSH (headings and suppl. chemical) and DataBank entries', function(done){
    var pmid = 19237716;
    fs.readFile(path.join(root, pmid + '.xml'), {encoding: 'utf8'}, function(err, xml){
      if(err) throw err;     
      var pkg = pubmed.parseXml(xml, pmid)
      //fs.writeFileSync(path.join(root, pmid + '.json'), JSON.stringify(pkg, null, 2));
      fs.readFile(path.join(root, pmid + '.json'), function(err, expected){
        assert.deepEqual(pkg, JSON.parse(expected));
        done();
      });           
    });
  });

});

