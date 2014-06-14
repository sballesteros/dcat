var request = require('request')
  , fs = require('fs')
  , url = require('url')
  , path = require('path')
  , BASE = require('package-jsonld').BASE
  , DOMParser = require('xmldom').DOMParser
  , _ = require('underscore')
  , tools = require('./lib/tools');

exports.pubmed = pubmed;
exports.parseXml = parseXml;

/**
 * 'this' is an Ldpm instance
 */
function pubmed(uri, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = { writeHTML: true };
  }

  var that = this;

  var puri = url.parse(uri, true);

  // check url  
  if((puri.hostname === 'eutils.ncbi.nlm.nih.gov') && (puri.pathname === '/entrez/eutils/efetch.fcgi') && puri.query.id){
    var pmid = puri.query.id;

    // 1. fetch xml
    that.logHttp('GET', uri);
    request(uri, function(error,response, xml){
      if(error) return callback(error);

      that.logHttp(response.statusCode, uri)

      if(response.statusCode >= 400){
        var err = new Error(xml);
        err.code = response.statusCode;
        return callback(err);
      }

      // 2. parse xml
      try{
        var pkg = parseXml(xml, pmid);
      }  catch(err){
        return callback(err);
      }
      
      callback(null, pkg);
    });

  } else {
    callback(new Error('entrez called with wrong url'))
  }

};

/**
 * see http://www.nlm.nih.gov/bsd/licensee/elements_descriptions.html
 */ 
function parseXml(xml, pmid){

  var article =  { '@type': 'ScholarlyArticle', 'pmid': pmid };

  var doc = new DOMParser().parseFromString(xml, 'text/xml');

  var $PubmedArticle = doc.getElementsByTagName('PubmedArticle')[0];
  if($PubmedArticle){
    var $ArticleTitle = $PubmedArticle.getElementsByTagName('ArticleTitle')[0];
    if($ArticleTitle){
      article.headline = tools.cleanText($ArticleTitle.textContent);
      //remove [] Cf http://www.nlm.nih.gov/bsd/licensee/elements_descriptions.html#articletitle
      article.headline = article.headline.replace(/^\[/, '').replace(/\]\.*$/, '');
    }

    var $Abstract = $PubmedArticle.getElementsByTagName('Abstract')[0];
    if($Abstract){
      //CF http://www.nlm.nih.gov/bsd/licensee/elements_descriptions.html structured abstract.
      //Abstract can be structured => TODO use annotation or RDFa to keep structure.
      //e.g PMID:19897313  http://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=19897313&rettype=abstract&retmode=xml

      var abstractTexts = []
      var $AbstractTexts = $Abstract.getElementsByTagName('AbstractText');
      if($AbstractTexts){
        Array.prototype.forEach.call($AbstractTexts, function($AbstractText){
          abstractTexts.push(tools.cleanText($AbstractText.textContent));
        });
      }
      if(abstractTexts.length){
        article.abstract = tools.cleanText(abstractTexts.join(' '));
      }
    }

    var $Journal = $PubmedArticle.getElementsByTagName('Journal')[0];
    var jsDate;
    if($Journal){
      var journal = { '@type': 'Journal' };

      var $Title = $Journal.getElementsByTagName('Title')[0];
      if($Title){
        journal.name = tools.cleanText($Title.textContent);
      }

      var $ISSN = $Journal.getElementsByTagName('ISSN')[0];
      if($ISSN){
        journal.issn = tools.cleanText($ISSN.textContent);
      }

      if(Object.keys(journal).length){
        article.journal = journal;
      }
      
      var $volume = $Journal.getElementsByTagName('Volume')[0];
      if($volume){
        article.volume = parseInt(tools.cleanText($volume.textContent), 10);        
      }

      var $issue = $Journal.getElementsByTagName('Issue')[0];
      if($issue){
        article.issue = parseInt(tools.cleanText($issue.textContent), 10);        
      }

      var $PubDate = $Journal.getElementsByTagName('PubDate')[0];
      if($PubDate){
        var $day = $PubDate.getElementsByTagName('Day')[0];
        var $month = $PubDate.getElementsByTagName('Month')[0];
        var $year = $PubDate.getElementsByTagName('Year')[0];

        if($month){
          var abrMonth2int = {
            'jan': 0,
            'feb': 1,
            'mar': 2,
            'apr': 3,
            'may': 4,
            'jun': 5,
            'july': 6,
            'aug': 7,
            'sep': 8,
            'oct': 9,
            'nov': 10,
            'dec': 11
          };

          var month = abrMonth2int[$month.textContent.trim().toLowerCase()];
        }

        if($year && month && $day){
          jsDate = new Date($year.textContent, month, $day.textContent);
        } else if($year && month){
          jsDate = new Date($year.textContent, month);
        } else if($year){
          jsDate = new Date($year.textContent);
        }

        if(jsDate){
          article.datePublished = jsDate.toISOString();
        }
      }

      var journalShortName; //will be used to generate name of the pkg
      var $ISOAbbreviation = $Journal.getElementsByTagName('ISOAbbreviation')[0];
      if($ISOAbbreviation){
        journalShortName = tools.cleanText($ISOAbbreviation.textContent);
        journalShortName = journalShortName.replace(/ /g, '-').replace(/\W/g, '').toLowerCase();
      }
    }

    //doi
    var $ELocationID = $PubmedArticle.getElementsByTagName('ELocationID');
    if($ELocationID){
      for(var i=0; i<$ELocationID.length; i++){
        if($ELocationID[i].getAttribute('EIdType') === 'doi'){
          var doiValid = $ELocationID[i].getAttribute('ValidYN');
          if(!doiValid || doiValid === 'Y'){
            article.doi = tools.cleanText($ELocationID[i].textContent);
            break;
          }
        }
      }
    }

    if(article.doi){
      article.url = 'http://dx.doi.org/' + article.doi;
    }


    //pkg stuff
    var pkg = {};

    var authors = {};

    var $AuthorList = $PubmedArticle.getElementsByTagName('AuthorList')[0];
    if($AuthorList){
      var $Authors = $AuthorList.getElementsByTagName('Author');
      if($Authors){
        Array.prototype.forEach.call($Authors, function($Author, i){
          var person = { '@type': 'Person' };

          var $LastName = $Author.getElementsByTagName('LastName')[0];
          if($LastName){
            person.familyName = tools.cleanText($LastName.textContent);
          }

          var $ForeName = $Author.getElementsByTagName('ForeName')[0];
          if($ForeName){
            person.givenName = tools.cleanText($ForeName.textContent);
          }

          if(person.familyName && person.givenName ){
            person.name = person.givenName + ' ' + person.familyName;
          }

          var $Affiliation = $Author.getElementsByTagName('Affiliation')[0];
          if($Affiliation){
            person.affiliation = {
              '@type': 'Organization',
              description: tools.cleanText($Affiliation.textContent)
            }
          }
          
          if(Object.keys(person).length > 1){
            if(i === 0){
              authors.author = person;
            } else {
              if(!authors.contributor){
                authors.contributor = [];
              }
              authors.contributor.push(person);
            }
          }

        });
      }
    }

    var pkgName = [];

    if(journalShortName){
      pkgName.push(journalShortName);
    }

    if(authors.author && authors.author.familyName){
      pkgName.push(tools.removeDiacritics(authors.author.familyName.toLowerCase()).replace(/\W/g, ''));
    }

    if(jsDate){
      pkgName.push(jsDate.getFullYear());
    }

    if(pkgName.length>=2){
      pkg.name = pkgName.join('-');
    } else {
      pkg.name = pmid;
    }

    pkg.version = '0.0.0';

    //keywords e.g PMID 24920540
    //TODO: take advandage of Owner attribute Cf http://www.nlm.nih.gov/bsd/licensee/elements_descriptions.html#Keyword
    var keywords = [];
    var $KeywordLists = $PubmedArticle.getElementsByTagName('KeywordList');
    if($KeywordLists){
      Array.prototype.forEach.call($KeywordLists, function($KeywordList){
        var $Keywords = $KeywordList.getElementsByTagName('Keyword');
        if($Keywords){
          Array.prototype.forEach.call($Keywords, function($Keyword){
            keywords.push(tools.cleanText($Keyword.textContent).toLowerCase());            
          });
        }
      });    
    }

    if(keywords.length){
      pkg.keywords = _.uniq(keywords);
    }

    if(authors.author){
      pkg.author = authors.author;
    }

    if(authors.contributor){
      pkg.contributor = authors.contributor;
    }

    pkg.provider = {
      '@type': 'Organization',
      '@id': 'http://www.ncbi.nlm.nih.gov/pubmed/',
      description: 'From MEDLINE®/PubMed®, a database of the U.S. National Library of Medicine.'
    };

    pkg.accountablePerson = {
      '@type': 'Organization',
      name: 'Standard Analytics IO',
      email: 'contact@standardanalytics.io'
    };
    
    var citations = [];
    var $CommentsCorrectionsList = $PubmedArticle.getElementsByTagName('CommentsCorrectionsList')[0];
    if($CommentsCorrectionsList){
      var $CommentsCorrections = $CommentsCorrectionsList.getElementsByTagName('CommentsCorrections');
      if($CommentsCorrections){
        Array.prototype.forEach.call($CommentsCorrections, function($CommentsCorrections){
          var ref = {};
          var refType = $CommentsCorrections.getAttribute('RefType');
          if(refType){
            ref['@type'] = ['ScholarlyArticle', refType];
          }

          var $RefSource = $CommentsCorrections.getElementsByTagName('RefSource')[0];
          if($RefSource){
            ref.description = tools.cleanText($RefSource.textContent);
          }

          var $PMID = $CommentsCorrections.getElementsByTagName('PMID')[0];
          if($PMID){
            ref.pmid = tools.cleanText($PMID.textContent);
          }

          if(Object.keys(ref).length){
            citations.push(ref);
          }
        });
      }
    }
    if(citations.length){
      article.citation = citations;
    }
     
    if(Object.keys(article).length){
      pkg.article = [article];
    }

    //TODO MeSH and Chemical List
//    var path = tools.findNodePaths(data,['MeshHeadingList']);
//    if(path['MeshHeadingList']){
//      var mesh = traverse(data).get(path['MeshHeadingList']);
//      if(mesh[0]['MeshHeading']){
//
//        pkg.annotation = [];
//        var graph = [];
//        var hasBody = {
//          "@type": ["Tag", "Mesh"],
//          "@context": BASE + "/mesh.jsonld"
//        };
//        mesh[0]['MeshHeading'].forEach(function(x){
//          var tmp = {
//            "@type": "Heading",
//          };
//          if(x.DescriptorName){
//            tmp.descriptor = {
//              '@type': 'Record',
//              name: x.DescriptorName[0]['_'],
//              majorTopic: (x.DescriptorName[0]['$']['MajorTopicYN'] === 'Y')
//            }
//            if(x.QualifierName){
//              tmp.qualifier = {
//                '@type': 'Record',
//                name: x.QualifierName[0]['_'],
//                majorTopic: (x.QualifierName[0]['$']['MajorTopicYN'] === 'Y')
//              }
//            }
//          }
//          graph.push(tmp)
//        });
//        hasBody['@graph'] = graph;
//
//
//        pkg.annotation.push({
//          "@type": "Annotation",
//          annotatedAt: pkg.article[0].datePublished,
//          annotatedBy: {
//            "@id": "http://www.ncbi.nlm.nih.gov/pubmed",
//            "@type": "Organization",
//            name: "PubMed"
//          },
//          serializedBy: {
//            "@id": "http://standardanalytics.io",
//            "@type": "Organization",
//            name: "Standard Analytics IO"
//          },
//          serializedAt: (new Date()).toISOString(),
//          motivatedBy: "oa:tagging",
//          hasBody: [
//            hasBody
//          ],
//          hasTarget: [
//            {
//              "@type": "SpecificResource",
//              hasSource: "r/f9b634be34cb3f2af4fbf4395e3f24b3834da926",
//              hasScope: pkg.name + '/' + pkg.version + '/article/' + pkg.article[0].name,
//              hasState: {
//                "@type": "HttpRequestState",
//                value: "Accept: text/html"
//              }
//            }
//          ]
//        })
//      }
//    }
    
  }

  return pkg;
}

