var request = require('request')
  , fs = require('fs')
  , url = require('url')
  , http = require('http')
  , exec = require('child_process').exec
  , spawn = require('child_process').spawn
  , jsdom = require('jsdom').jsdom
  , async = require('async')
  , path = require('path')
  , temp = require('temp')
  , _ = require('underscore')
  , emitter = require('events').EventEmitter
  , events = require('events')
  , tar = require('tar')
  , targz = require('tar.gz')
  , uuid = require('node-uuid')
  , Client = require('ftp')
  , xml2js = require('xml2js')
  , DecompressZip = require('decompress-zip')
  , zlib = require('zlib')
  , traverse = require('traverse')
  , recursiveReaddir = require('recursive-readdir')
  , Ldpm = require('../index')
  , DOMParser = require('xmldom').DOMParser;



module.exports = {
  pubmed: pubmed,
  pmxml2jsonld: pmxml2jsonld
}


/**
 * 'this' is an Ldpm instance
 */

function pubmed(uri, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var that = this;

  if(uri.slice(0,57)=='http://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?'){
    var pkg = _initPkg();
    _addMetadata(pkg,uri,that,function(err,pkg){
      callback(null,pkg);
    });
  } else {
    callback(new Error('entrez called with wrong url'))
  }

};



function _extractBetween(str,str_beg,str_end){
  var beg = str.indexOf(str_beg) + str_beg.length;
  if(arguments.length === 3){
    var end = beg + str.slice(beg,str.length).indexOf(str_end);
  } else {
    var end = str.length;
  }
  return str.slice(beg,end);
}



function _initPkg(uri,article){

  var pkg = {
    version: '0.0.0',
  };

  return pkg;
}


function _findNodePaths(obj,names){
  var paths = {};
  traverse(obj).forEach(function(x){
    if(names.indexOf(this.key)>-1){
      if(paths[this.key]===undefined){
        paths[this.key] = this.path;
      }
    }
  });
  return paths;
}

function pmxml2jsonld(pkg,body,callback){

  var parser = new xml2js.Parser();
  var meta = {};
  var relPaths;

  parser.parseString(body,function(err,body){


    if(err) return callback(err);

    var pathArt = _findNodePaths(body,['PubmedArticle','PMID','Article']);
    // if(pathArt['PubmedArticle']===undefined){
    //   return callback(new Error('not the id of a pubmed article'));
    // }

    if(pathArt['PubmedArticle']){
      var data = traverse(body).get(pathArt['PubmedArticle'])[0];
    } else {
      var data = body;//traverse(body).get(pathArt['Article'])[0];
    }

    pkg.article = [{}]; 
    pkg.article[0]['@type'] = [ 'ScholarlyArticle' ];

    if(traverse(body).get(pathArt['PMID'])[0]['$']){
      pkg.article[0].pmid = traverse(body).get(pathArt['PMID'])[0]['_'];
    } else {
      pkg.article[0].pmid = traverse(body).get(pathArt['PMID'])[0];
    }

    var $journal = traverse(data).get(_findNodePaths(data,['Journal'])['Journal'])[0];
    relPaths = _findNodePaths($journal,
      [
        'Title',
        'Volume',
        'Issue',
        'PubDate',
        'ISSN',
        'ISOAbbreviation'
      ]
    );

    if(relPaths['Title']){
      pkg.article[0].journal = { name: traverse($journal).get(relPaths['Title'])[0] };
    }

    if(relPaths['Volume']){
      pkg.article[0].volume = traverse($journal).get(relPaths['Volume'])[0];
    }

    if(relPaths['Issue']){
      pkg.article[0].issue = traverse($journal).get(relPaths['Issue'])[0];
    }

    if(relPaths['PubDate']){
      var tmpDate = '';
      if(traverse($journal).get(relPaths['PubDate'])[0]['Year']){
        tmpDate += traverse($journal).get(relPaths['PubDate'])[0]['Year'][0];
        meta.year = traverse($journal).get(relPaths['PubDate'])[0]['Year'][0];
      }
      if(traverse($journal).get(relPaths['PubDate'])[0]['Month']){
        tmpDate += '-' + traverse($journal).get(relPaths['PubDate'])[0]['Month'][0];
      }
      if(traverse($journal).get(relPaths['PubDate'])[0]['Day']){
        tmpDate += '-' + traverse($journal).get(relPaths['PubDate'])[0]['Day'][0];
      }
      if(tmpDate!=''){
        pkg.article[0].datePublished = (new Date(tmpDate).toISOString());
      }
    }

    if(relPaths['ISSN']){
      if(pkg.article[0].journal){
        if(traverse($journal).get(relPaths['ISSN'])[0]['$']){
          pkg.article[0].journal.issn = traverse($journal).get(relPaths['ISSN'])[0]['_'];
        } else {
          pkg.article[0].journal.issn = traverse($journal).get(relPaths['ISSN'])[0];
        }
      }
    }

    if(pkg.article[0].journal){
      pkg.copyrightHolder = pkg.article[0].journal;
    }

    if(relPaths['ISOAbbreviation']){
      meta.journalShortName = '';
      traverse($journal).get(relPaths['ISOAbbreviation'])[0].split(' ').forEach(function(x,i){
        if(i>0){
          meta.journalShortName += '-'
        }
        meta.journalShortName += x.replace(/\W/g, '').toLowerCase();
      })
    } else if(pkg.article[0].journal.name){
      meta.journalShortName = '';
      pkg.article[0].journal.name.split(' ').forEach(function(x,i){
        if(i>0){
          meta.journalShortName += '-'
        }
        meta.journalShortName += x.replace(/\W/g, '').toLowerCase();
      })
    }

    var $article = traverse(data).get(_findNodePaths(data,['Article'])['Article'])[0];
    relPaths = _findNodePaths($article,
      [
        'ELocationID',
        'ArticleTitle',
        'AuthorList',
        'Abstract'
      ]
    );

    if(relPaths['Abstract']){
      if(traverse($article).get(relPaths['Abstract'])[0]['AbstractText'][0]['$']!=undefined){
        pkg.article[0].abstract = traverse($article).get(relPaths['Abstract'])[0]['AbstractText'][0]['_'];
      } else {
        pkg.article[0].abstract = traverse($article).get(relPaths['Abstract'])[0]['AbstractText'][0];
      }
    }

    if(relPaths['ELocationID']){
      traverse($article).get(relPaths['ELocationID']).forEach(function(x){
        if(x['$']['EIdType']==='doi'){
          pkg.article[0].doi = x['_'];
        }
      })  
    }
    if(pkg.article[0].doi){
      pkg.article[0].url = 'http://dx.doi.org/'+pkg.article[0].doi ;
    }

    if(relPaths['ArticleTitle']){
      pkg.article[0].headline = traverse($article).get(relPaths['ArticleTitle'])[0];
      pkg.description = pkg.article[0].headline;
    } else {
      callback(new Error('could not find the article title'));
    }

    if(relPaths['AuthorList']){
      var allAffilsNames = [];
      var allAffils = [];
      traverse($article).get(relPaths['AuthorList'])[0]['Author'].forEach(function(x){
        var author = {};
        if(x.LastName){
          author.familyName = x.LastName[0];
        }
        if(x.ForeName){
          author.givenName = x.ForeName[0];
        }
        if(author.familyName && author.givenName ){
          author.name = author.givenName + ' ' + author.familyName ;
        }
        if(x.Affiliation){
          author.affiliation = [];
          x.Affiliation[0].split(';').forEach(function(y){
            author.affiliation.push({ description: y.trim() });
            if(allAffilsNames.indexOf(y.trim())==-1){
              allAffils.push({ description: y.trim() });
              allAffilsNames.push(y.trim());
            }
          })
        }

        if(pkg.author){
          if(pkg.contributor==undefined){
            pkg.contributor = [];
          } 
          pkg.contributor.push(author);
        } else {
          pkg.author = author;
        }
      })
      pkg.sourceOrganisation = [ {
        '@id': 'http://www.nlm.nih.gov/',
        name: 'National Library of Medecine',
        department: 'Department of Health and Human Services',
        address: {
          addressCountry: 'US'
        }
      }]
      if(allAffils.length){
        pkg.sourceOrganisation = pkg.sourceOrganisation.concat(allAffils);
      }

    }

    pkg.provider = {
      '@id': 'http://www.ncbi.nlm.nih.gov/pubmed/',
      description: 'From MEDLINE®/PubMed®, a database of the U.S. National Library of Medicine.'
    }

    pkg.name = '';
    if(meta.journalShortName){
      pkg.name = meta.journalShortName;
      // var tmp = meta.journalShortName.toLowerCase();
      // tmp.split(' ').forEach(function(x){
      //   if(pkg.name!='') pkg.name+='-';
      //   pkg.name += x.replace(/\W/g, '');
      // })
    }
    if(pkg.article[0].author){
      if(pkg.article[0].author.familyName){
        pkg.name += '-' + removeDiacritics(pkg.article[0].author.familyName.toLowerCase()).replace(/\W/g, '');
      } else {
        callback(new Error('did not find the author family name'));
      }
    } else {
      pkg.name += '-' + removeDiacritics(pkg.article[0].headline.split(' ')[0].toLowerCase()).replace(/\W/g, '');
    }
    if(meta.year){
      pkg.name += '-' + meta.year;
    }
    pkg.article[0].name = pkg.name;

    pkg.datePublished = (new Date()).toISOString();
    pkg.dateCreated = pkg.article[0].datePublished;

  
    var keyword = [];

    // TODO: take full advantage of this markup storing it as annotations

    var path = _findNodePaths(data,['ChemicalList']);
    if(path['ChemicalList']){
      var chemical = traverse(data).get(path['ChemicalList']);
      if(chemical[0]['Chemical']){
        chemical[0]['Chemical'].forEach(function(x){
          if(keyword.indexOf(x.NameOfSubstance[0])==-1){
            keyword.push(x.NameOfSubstance[0]);
          }
        })
        pkg.rawChemical = chemical[0]['Chemical'];
      }  
    }


    var path = _findNodePaths(data,['MeshHeadingList']);
    if(path['MeshHeadingList']){
      var mesh = traverse(data).get(path['MeshHeadingList']);
      if(mesh[0]['MeshHeading']){
        mesh[0]['MeshHeading'].forEach(function(x){
          x.DescriptorName[0]['_'].split(',').forEach(function(y){
            if(keyword.indexOf(y.trim())==-1){
              keyword.push(y.trim());
            }
          })
          if(x.QualifierName){
            x.QualifierName[0]['_'].split(',').forEach(function(y){
              if(keyword.indexOf(y.trim())==-1){
                keyword.push(y.trim());
              }
            });
          }
        })
        pkg.rawMesh = mesh[0]['MeshHeading'];
      }  
    }         


    if(keyword.length){
      pkg.article[0].keyword = keyword;
      pkg.keyword = keyword;
    }

    var citations = [];
    var path = _findNodePaths(data,['CommentsCorrectionsList']);
    if(path['CommentsCorrectionsList']){
      var cites = traverse(data).get(path['CommentsCorrectionsList']);
      if(cites[0]['CommentsCorrections']){
        cites[0]['CommentsCorrections'].forEach(function(x){
          var citation = {};
          if(x['RefSource']){
            citation.description = x['RefSource'][0];
          } 
          if(x['PMID']){
            if(x['PMID'][0]['_']){
              citation.pmid = x['PMID'][0]['_'];
            } else {
              citation.pmid = x['PMID'][0];
            }
          }
          citations.push(citation);
        })
      }  
    }
    if(citations.length){
      pkg.article.citation = citations;
    }

    return callback(null,pkg);

  })

}


function _json2html(ldpm,pkg,callback){
  var html  = "<!doctype html>\n";
  html += "<html>\n";
  html += "<head>\n<title>\n" + pkg.article[0].headline + "</title>\n<meta charset='UTF-8'>\n";
  html += '<script type="application/ld+json">\n';
  html += JSON.stringify(pkg,null,4);
  html += "</script>\n";
  html += "\n</head>\n";
  html += "<body>\n";
  html += "<article>\n";
  html += "<h1>\n" + pkg.article[0].headline + "\n</h1>\n";
  if(pkg.keyword){
    html += '<section class="keywords">\n';
    html += '<ul>\n';
    pkg.keyword.forEach(function(k){
      html += '<li>\n';
      html += k + '\n';
      html += '</li>\n';
    })
    html += '</ul>\n';
    html += '</section>\n';
  }
  if(pkg.author){
    html += '<section class="authors" >\n';
    html += '<section class="author" >\n';
    html += '<span>\n';
    html += pkg.author.name + '\n';
    html += '</span>\n';
    if(pkg.author.email){
      html += '<span>\n';
      html += pkg.author.email + '\n';
      html += '</span>\n';
    }
    if(pkg.author.affiliation){
      html += '<ul>\n';
      pkg.author.affiliation.forEach(function(aff){
        html += '<li>\n';
        html += '<span>\n';
        html += aff.description + '\n';
        html += '</span>\n';
        html += '</li>\n';        
      })
      html += '</ul>\n';
    }
    html += '</section>\n';    
  }
  if(pkg.contributor){
    pkg.contributor.forEach(function(contr){
      html += '<section class="contributor">\n';
      html += '<span>\n';
      html += contr.name + '\n';
      html += '</span>\n';
      if(contr.email){
        html += '<span>\n';
        html += contr.email  + '\n';
        html += '</span>\n';
      }
      if(contr.affiliation){
        html += '<ul>\n';
        contr.affiliation.forEach(function(aff){
          html += '<li>\n';
          html += '<span>\n';
          html += aff.description + '\n';
          html += '</span>\n';
          html += '</li>\n';        
        })
        html += '</ul>\n';
      }
      html += '</section>\n';    
    })
  }
  html += '</section>\n';
  if(pkg.provider){
    html += '<section class="provider">\n';
    html += '<h3>Provider</h3>\n';
    html += pkg.provider.description + '\n';
    html += '</section>\n';
  }
  if(pkg.editor){
    html += '<section class="editors">\n';
    html += '<h3>Editor</h3>\n';
    pkg.editor.forEach(function(ed){
      html += '<section>\n';
      if(ed.name){
        html += '<span>\n';
        html += ed.name + '\n';
        html += '</span>\n';
      }
      if(ed.affiliation){
        html += '<ul>\n';
        ed.affiliation.forEach(function(aff){
          html += '<li>\n';
          html += '<span>\n';
          html += aff.description + '\n';
          html += '</span>\n';
          html += '</li>\n';        
        })
        html += '</ul>\n';
      }
      html += '</section>\n';
    })
    html += '</section>\n'
  }
  if(pkg.journal){
    html += '<section class="journal">\n';
    html += '<h3>Journal</h3>';
    if(pkg.journal.name){
      html += '<span>\n';
      html += pkg.journal.name + '\n';
      html += '</span>\n';
    }
    if(pkg.journal.name){
      html += '<span>\n';
      html += pkg.journal.issn + '\n';
      html += '</span>\n';
    }
    html += '</section>\n';
  }

  if(pkg.article[0].abstract!=undefined){
    var id = uuid.v4();
    html += '<section id="' + id + '" typeof="http://salt.semanticauthoring.org/ontologies/sro#Abstract">\n'; //+ '" resource="' + pkg.name + '/' + id + '">\n';
    html += "<h2>Abstract</h2>\n";
    html += pkg.article[0].abstract;
    html += '\n</section>\n';
  } 
  html += "</article>\n";
  html += "</body>\n";
  html += "</html>";
  fs.writeFile(pkg.article[0].name + '.html',html,function(err){
    if(err) return callback(err);
    pkg.article[0].encoding = [{
      contentPath: pkg.article[0].name + '.html',
      encodingFormat: "text/html"
    }]
    callback(null,pkg);
  })
}

function _addMetadata(pkg,uri,ldpm,callback){
  var pmcid = _extractBetween(uri,'PMC');
  ldpm.logHttp('GET', uri);
  request(uri,
    function(error,response,body){
      if(error) return callback(error);
      ldpm.logHttp(response.statusCode, uri)
      pmxml2jsonld(pkg,body,function(err,pkg){
        _json2html(ldpm,pkg, callback);
      })
    }
  );
}


function _extractKeywords(obj){
  if(obj['subj-group']!=undefined){
    var res = obj['subject'];
    obj['subj-group'].forEach(function(x){
      res = res.concat(_extractKeywords(x));
    })
    return res;
  } else {
    return obj['subject'];
  }
}

var defaultDiacriticsRemovalMap = [
    {'base':'A', 'letters':/[\u0041\u24B6\uFF21\u00C0\u00C1\u00C2\u1EA6\u1EA4\u1EAA\u1EA8\u00C3\u0100\u0102\u1EB0\u1EAE\u1EB4\u1EB2\u0226\u01E0\u00C4\u01DE\u1EA2\u00C5\u01FA\u01CD\u0200\u0202\u1EA0\u1EAC\u1EB6\u1E00\u0104\u023A\u2C6F]/g},
    {'base':'AA','letters':/[\uA732]/g},
    {'base':'AE','letters':/[\u00C6\u01FC\u01E2]/g},
    {'base':'AO','letters':/[\uA734]/g},
    {'base':'AU','letters':/[\uA736]/g},
    {'base':'AV','letters':/[\uA738\uA73A]/g},
    {'base':'AY','letters':/[\uA73C]/g},
    {'base':'B', 'letters':/[\u0042\u24B7\uFF22\u1E02\u1E04\u1E06\u0243\u0182\u0181]/g},
    {'base':'C', 'letters':/[\u0043\u24B8\uFF23\u0106\u0108\u010A\u010C\u00C7\u1E08\u0187\u023B\uA73E]/g},
    {'base':'D', 'letters':/[\u0044\u24B9\uFF24\u1E0A\u010E\u1E0C\u1E10\u1E12\u1E0E\u0110\u018B\u018A\u0189\uA779]/g},
    {'base':'DZ','letters':/[\u01F1\u01C4]/g},
    {'base':'Dz','letters':/[\u01F2\u01C5]/g},
    {'base':'E', 'letters':/[\u0045\u24BA\uFF25\u00C8\u00C9\u00CA\u1EC0\u1EBE\u1EC4\u1EC2\u1EBC\u0112\u1E14\u1E16\u0114\u0116\u00CB\u1EBA\u011A\u0204\u0206\u1EB8\u1EC6\u0228\u1E1C\u0118\u1E18\u1E1A\u0190\u018E]/g},
    {'base':'F', 'letters':/[\u0046\u24BB\uFF26\u1E1E\u0191\uA77B]/g},
    {'base':'G', 'letters':/[\u0047\u24BC\uFF27\u01F4\u011C\u1E20\u011E\u0120\u01E6\u0122\u01E4\u0193\uA7A0\uA77D\uA77E]/g},
    {'base':'H', 'letters':/[\u0048\u24BD\uFF28\u0124\u1E22\u1E26\u021E\u1E24\u1E28\u1E2A\u0126\u2C67\u2C75\uA78D]/g},
    {'base':'I', 'letters':/[\u0049\u24BE\uFF29\u00CC\u00CD\u00CE\u0128\u012A\u012C\u0130\u00CF\u1E2E\u1EC8\u01CF\u0208\u020A\u1ECA\u012E\u1E2C\u0197]/g},
    {'base':'J', 'letters':/[\u004A\u24BF\uFF2A\u0134\u0248]/g},
    {'base':'K', 'letters':/[\u004B\u24C0\uFF2B\u1E30\u01E8\u1E32\u0136\u1E34\u0198\u2C69\uA740\uA742\uA744\uA7A2]/g},
    {'base':'L', 'letters':/[\u004C\u24C1\uFF2C\u013F\u0139\u013D\u1E36\u1E38\u013B\u1E3C\u1E3A\u0141\u023D\u2C62\u2C60\uA748\uA746\uA780]/g},
    {'base':'LJ','letters':/[\u01C7]/g},
    {'base':'Lj','letters':/[\u01C8]/g},
    {'base':'M', 'letters':/[\u004D\u24C2\uFF2D\u1E3E\u1E40\u1E42\u2C6E\u019C]/g},
    {'base':'N', 'letters':/[\u004E\u24C3\uFF2E\u01F8\u0143\u00D1\u1E44\u0147\u1E46\u0145\u1E4A\u1E48\u0220\u019D\uA790\uA7A4]/g},
    {'base':'NJ','letters':/[\u01CA]/g},
    {'base':'Nj','letters':/[\u01CB]/g},
    {'base':'O', 'letters':/[\u004F\u24C4\uFF2F\u00D2\u00D3\u00D4\u1ED2\u1ED0\u1ED6\u1ED4\u00D5\u1E4C\u022C\u1E4E\u014C\u1E50\u1E52\u014E\u022E\u0230\u00D6\u022A\u1ECE\u0150\u01D1\u020C\u020E\u01A0\u1EDC\u1EDA\u1EE0\u1EDE\u1EE2\u1ECC\u1ED8\u01EA\u01EC\u00D8\u01FE\u0186\u019F\uA74A\uA74C]/g},
    {'base':'OI','letters':/[\u01A2]/g},
    {'base':'OO','letters':/[\uA74E]/g},
    {'base':'OU','letters':/[\u0222]/g},
    {'base':'P', 'letters':/[\u0050\u24C5\uFF30\u1E54\u1E56\u01A4\u2C63\uA750\uA752\uA754]/g},
    {'base':'Q', 'letters':/[\u0051\u24C6\uFF31\uA756\uA758\u024A]/g},
    {'base':'R', 'letters':/[\u0052\u24C7\uFF32\u0154\u1E58\u0158\u0210\u0212\u1E5A\u1E5C\u0156\u1E5E\u024C\u2C64\uA75A\uA7A6\uA782]/g},
    {'base':'S', 'letters':/[\u0053\u24C8\uFF33\u1E9E\u015A\u1E64\u015C\u1E60\u0160\u1E66\u1E62\u1E68\u0218\u015E\u2C7E\uA7A8\uA784]/g},
    {'base':'T', 'letters':/[\u0054\u24C9\uFF34\u1E6A\u0164\u1E6C\u021A\u0162\u1E70\u1E6E\u0166\u01AC\u01AE\u023E\uA786]/g},
    {'base':'TZ','letters':/[\uA728]/g},
    {'base':'U', 'letters':/[\u0055\u24CA\uFF35\u00D9\u00DA\u00DB\u0168\u1E78\u016A\u1E7A\u016C\u00DC\u01DB\u01D7\u01D5\u01D9\u1EE6\u016E\u0170\u01D3\u0214\u0216\u01AF\u1EEA\u1EE8\u1EEE\u1EEC\u1EF0\u1EE4\u1E72\u0172\u1E76\u1E74\u0244]/g},
    {'base':'V', 'letters':/[\u0056\u24CB\uFF36\u1E7C\u1E7E\u01B2\uA75E\u0245]/g},
    {'base':'VY','letters':/[\uA760]/g},
    {'base':'W', 'letters':/[\u0057\u24CC\uFF37\u1E80\u1E82\u0174\u1E86\u1E84\u1E88\u2C72]/g},
    {'base':'X', 'letters':/[\u0058\u24CD\uFF38\u1E8A\u1E8C]/g},
    {'base':'Y', 'letters':/[\u0059\u24CE\uFF39\u1EF2\u00DD\u0176\u1EF8\u0232\u1E8E\u0178\u1EF6\u1EF4\u01B3\u024E\u1EFE]/g},
    {'base':'Z', 'letters':/[\u005A\u24CF\uFF3A\u0179\u1E90\u017B\u017D\u1E92\u1E94\u01B5\u0224\u2C7F\u2C6B\uA762]/g},
    {'base':'a', 'letters':/[\u0061\u24D0\uFF41\u1E9A\u00E0\u00E1\u00E2\u1EA7\u1EA5\u1EAB\u1EA9\u00E3\u0101\u0103\u1EB1\u1EAF\u1EB5\u1EB3\u0227\u01E1\u00E4\u01DF\u1EA3\u00E5\u01FB\u01CE\u0201\u0203\u1EA1\u1EAD\u1EB7\u1E01\u0105\u2C65\u0250]/g},
    {'base':'aa','letters':/[\uA733]/g},
    {'base':'ae','letters':/[\u00E6\u01FD\u01E3]/g},
    {'base':'ao','letters':/[\uA735]/g},
    {'base':'au','letters':/[\uA737]/g},
    {'base':'av','letters':/[\uA739\uA73B]/g},
    {'base':'ay','letters':/[\uA73D]/g},
    {'base':'b', 'letters':/[\u0062\u24D1\uFF42\u1E03\u1E05\u1E07\u0180\u0183\u0253]/g},
    {'base':'c', 'letters':/[\u0063\u24D2\uFF43\u0107\u0109\u010B\u010D\u00E7\u1E09\u0188\u023C\uA73F\u2184]/g},
    {'base':'d', 'letters':/[\u0064\u24D3\uFF44\u1E0B\u010F\u1E0D\u1E11\u1E13\u1E0F\u0111\u018C\u0256\u0257\uA77A]/g},
    {'base':'dz','letters':/[\u01F3\u01C6]/g},
    {'base':'e', 'letters':/[\u0065\u24D4\uFF45\u00E8\u00E9\u00EA\u1EC1\u1EBF\u1EC5\u1EC3\u1EBD\u0113\u1E15\u1E17\u0115\u0117\u00EB\u1EBB\u011B\u0205\u0207\u1EB9\u1EC7\u0229\u1E1D\u0119\u1E19\u1E1B\u0247\u025B\u01DD]/g},
    {'base':'f', 'letters':/[\u0066\u24D5\uFF46\u1E1F\u0192\uA77C]/g},
    {'base':'g', 'letters':/[\u0067\u24D6\uFF47\u01F5\u011D\u1E21\u011F\u0121\u01E7\u0123\u01E5\u0260\uA7A1\u1D79\uA77F]/g},
    {'base':'h', 'letters':/[\u0068\u24D7\uFF48\u0125\u1E23\u1E27\u021F\u1E25\u1E29\u1E2B\u1E96\u0127\u2C68\u2C76\u0265]/g},
    {'base':'hv','letters':/[\u0195]/g},
    {'base':'i', 'letters':/[\u0069\u24D8\uFF49\u00EC\u00ED\u00EE\u0129\u012B\u012D\u00EF\u1E2F\u1EC9\u01D0\u0209\u020B\u1ECB\u012F\u1E2D\u0268\u0131]/g},
    {'base':'j', 'letters':/[\u006A\u24D9\uFF4A\u0135\u01F0\u0249]/g},
    {'base':'k', 'letters':/[\u006B\u24DA\uFF4B\u1E31\u01E9\u1E33\u0137\u1E35\u0199\u2C6A\uA741\uA743\uA745\uA7A3]/g},
    {'base':'l', 'letters':/[\u006C\u24DB\uFF4C\u0140\u013A\u013E\u1E37\u1E39\u013C\u1E3D\u1E3B\u017F\u0142\u019A\u026B\u2C61\uA749\uA781\uA747]/g},
    {'base':'lj','letters':/[\u01C9]/g},
    {'base':'m', 'letters':/[\u006D\u24DC\uFF4D\u1E3F\u1E41\u1E43\u0271\u026F]/g},
    {'base':'n', 'letters':/[\u006E\u24DD\uFF4E\u01F9\u0144\u00F1\u1E45\u0148\u1E47\u0146\u1E4B\u1E49\u019E\u0272\u0149\uA791\uA7A5]/g},
    {'base':'nj','letters':/[\u01CC]/g},
    {'base':'o', 'letters':/[\u006F\u24DE\uFF4F\u00F2\u00F3\u00F4\u1ED3\u1ED1\u1ED7\u1ED5\u00F5\u1E4D\u022D\u1E4F\u014D\u1E51\u1E53\u014F\u022F\u0231\u00F6\u022B\u1ECF\u0151\u01D2\u020D\u020F\u01A1\u1EDD\u1EDB\u1EE1\u1EDF\u1EE3\u1ECD\u1ED9\u01EB\u01ED\u00F8\u01FF\u0254\uA74B\uA74D\u0275]/g},
    {'base':'oi','letters':/[\u01A3]/g},
    {'base':'ou','letters':/[\u0223]/g},
    {'base':'oo','letters':/[\uA74F]/g},
    {'base':'p','letters':/[\u0070\u24DF\uFF50\u1E55\u1E57\u01A5\u1D7D\uA751\uA753\uA755]/g},
    {'base':'q','letters':/[\u0071\u24E0\uFF51\u024B\uA757\uA759]/g},
    {'base':'r','letters':/[\u0072\u24E1\uFF52\u0155\u1E59\u0159\u0211\u0213\u1E5B\u1E5D\u0157\u1E5F\u024D\u027D\uA75B\uA7A7\uA783]/g},
    {'base':'s','letters':/[\u0073\u24E2\uFF53\u00DF\u015B\u1E65\u015D\u1E61\u0161\u1E67\u1E63\u1E69\u0219\u015F\u023F\uA7A9\uA785\u1E9B]/g},
    {'base':'t','letters':/[\u0074\u24E3\uFF54\u1E6B\u1E97\u0165\u1E6D\u021B\u0163\u1E71\u1E6F\u0167\u01AD\u0288\u2C66\uA787]/g},
    {'base':'tz','letters':/[\uA729]/g},
    {'base':'u','letters':/[\u0075\u24E4\uFF55\u00F9\u00FA\u00FB\u0169\u1E79\u016B\u1E7B\u016D\u00FC\u01DC\u01D8\u01D6\u01DA\u1EE7\u016F\u0171\u01D4\u0215\u0217\u01B0\u1EEB\u1EE9\u1EEF\u1EED\u1EF1\u1EE5\u1E73\u0173\u1E77\u1E75\u0289]/g},
    {'base':'v','letters':/[\u0076\u24E5\uFF56\u1E7D\u1E7F\u028B\uA75F\u028C]/g},
    {'base':'vy','letters':/[\uA761]/g},
    {'base':'w','letters':/[\u0077\u24E6\uFF57\u1E81\u1E83\u0175\u1E87\u1E85\u1E98\u1E89\u2C73]/g},
    {'base':'x','letters':/[\u0078\u24E7\uFF58\u1E8B\u1E8D]/g},
    {'base':'y','letters':/[\u0079\u24E8\uFF59\u1EF3\u00FD\u0177\u1EF9\u0233\u1E8F\u00FF\u1EF7\u1E99\u1EF5\u01B4\u024F\u1EFF]/g},
    {'base':'z','letters':/[\u007A\u24E9\uFF5A\u017A\u1E91\u017C\u017E\u1E93\u1E95\u01B6\u0225\u0240\u2C6C\uA763]/g}
];

var changes;
function removeDiacritics (str) {
    if(!changes) {
        changes = defaultDiacriticsRemovalMap;
    }
    for(var i=0; i<changes.length; i++) {
        str = str.replace(changes[i].letters, changes[i].base);
    }
    return str;
}
