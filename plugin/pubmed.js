var request = require('request')
  , fs = require('fs')
  , url = require('url')
  , async = require('async')
  , path = require('path')
  , BASE = require('package-jsonld').BASE
  , xml2js = require('xml2js')
  , traverse = require('traverse')
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

  // check url
  if(uri.slice(0,57)=='http://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?'){

    var pkg = { version: '0.0.0' };
    var pmcid = tools.extractBetween(uri,'PMC');

    // 1. fetch xml
    that.logHttp('GET', uri);
    request(uri, function(error,response,body){
      if(error) return callback(error);

      that.logHttp(response.statusCode, uri)

      if(response.statusCode >= 400){
        var err = new Error(body);
        err.code = response.statusCode;
        return callback(err);
      }

      // 2. parse xml
      parseXml(pkg,body,function(err,pkg){

        // 3. convert to html
        tools.json2html(that,{},pkg, opts, function(err,htmlBody){
          if(err) return callback(err);

          if(opts.writeHTML){
            // a. integrate the html article as a resource of the pkg
            fs.writeFile(path.join(that.root,pkg.article[0].name+'.html'),htmlBody,function(err){
              if(err) return callback(err);
              that.paths2resources([path.join(that.root,pkg.article[0].name+'.html')],{}, function(err,resources){
                if(err) return callback(err);

                pkg.article[0].encoding = [resources.article[0].encoding[0]];

                // b. extract pubmed annotations, adapt the target computing html hash, and add to the pkg
                var tmppkg = pkg;
                delete tmppkg.annotation;
                tools.addPubmedAnnotations(tmppkg,pkg,that,function(err,pkg){
                  if(err) return callback(err);
                  callback(null,pkg);
                });
              });
            });
          } else {
            callback(null,pkg);
          }
        });
      });
    });

  } else {
    callback(new Error('entrez called with wrong url'))
  }

};


function parseXml(pkg,body,callback){

  var parser = new xml2js.Parser();
  var meta = {};
  var relPaths;

  parser.parseString(body, function(err, body){

    if(err) return callback(err);

    var pathArt = tools.findNodePaths(body, ['PubmedArticle','PMID','Article']);

    if(pathArt['PubmedArticle']){
      if(typeof(traverse(body).get(pathArt['PubmedArticle'])) == 'object'){
        var data = traverse(body).get(pathArt['PubmedArticle']);
      } else {
        var data = traverse(body).get(pathArt['PubmedArticle'])[0];
      }
    } else {
      var data = body;
    }

    pkg.article = [{}];
    pkg.article[0]['@type'] = [ 'ScholarlyArticle' ];

    if(traverse(body).get(pathArt['PMID'])[0]['$']){
      pkg.article[0].pmid = traverse(body).get(pathArt['PMID'])[0]['_'];
    } else {
      pkg.article[0].pmid = traverse(body).get(pathArt['PMID'])[0];
    }
    if(tools.findNodePaths(data,['Journal'])['Journal']){
      var $journal = traverse(data).get(tools.findNodePaths(data,['Journal'])['Journal'])[0];
      relPaths = tools.findNodePaths($journal,
        [
          'Title',
          'Volume',
          'Issue',
          'PubDate',
          'ISSN',
          'ISOAbbreviation'
        ]
      );
    } else {
      relPaths = {};
    }

    if(relPaths['Title']){
      pkg.article[0].journal = {
        '@type': 'bibo:Journal',
        name: traverse($journal).get(relPaths['Title'])[0]
      };
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
    } else if(pkg.article[0].journal) {
      if(pkg.article[0].journal.name){
        meta.journalShortName = '';
        pkg.article[0].journal.name.split(' ').forEach(function(x,i){
          if(i>0){
            meta.journalShortName += '-'
          }
          meta.journalShortName += x.replace(/\W/g, '').toLowerCase();
        })
      }
    } else {
      meta.journalShortName = '';
    }

    if (tools.findNodePaths(data,['Article'])['Article']){
      var $article = traverse(data).get(tools.findNodePaths(data,['Article'])['Article'])[0];
      relPaths = tools.findNodePaths($article,
        [
          'ELocationID',
          'ArticleTitle',
          'AuthorList',
          'Abstract'
        ]
      );
    } else {
      relPaths = {};
    }

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
        var author = {
          '@type': 'Person'
        };
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
              allAffils.push({
                '@type': 'Organization',
                description: y.trim()
              });
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
        '@type': 'Organization',
        '@id': 'http://www.nlm.nih.gov/',
        name: 'National Library of Medecine',
        department: 'Department of Health and Human Services',
        address: {
          '@type': 'PostalAddress',
          addressCountry: 'US'
        }
      }]
      if(allAffils.length){
        pkg.sourceOrganisation = pkg.sourceOrganisation.concat(allAffils);
      }

    }

    pkg.provider = {
      '@type': 'Organization',
      '@id': 'http://www.ncbi.nlm.nih.gov/pubmed/',
      description: 'From MEDLINE®/PubMed®, a database of the U.S. National Library of Medicine.'
    }

    pkg.name = '';
    if(meta.journalShortName){
      pkg.name = meta.journalShortName;
    }
    if(pkg.author){
      if(pkg.author.familyName){
        pkg.name += '-' + tools.removeDiacritics(pkg.author.familyName.toLowerCase()).replace(/\W/g, '');
      } else {
        console.log('did not find the author family name');
      }
    } else {
      if(pkg.headline){
        pkg.name += '-' + tools.removeDiacritics(pkg.headline.split(' ')[0].toLowerCase()).replace(/\W/g, '');
      } else if(pkg.article.headline) {
        pkg.name += '-' + tools.removeDiacritics(pkg.article.headline.split(' ')[0].toLowerCase()).replace(/\W/g, '');
      }
    }
    if(meta.year){
      pkg.name += '-' + meta.year;
    }
    pkg.article[0].name = pkg.name;

    pkg.datePublished = (new Date()).toISOString();
    pkg.dateCreated = pkg.article[0].datePublished;


    var path = tools.findNodePaths(data,['MeshHeadingList']);
    if(path['MeshHeadingList']){
      var mesh = traverse(data).get(path['MeshHeadingList']);
      if(mesh[0]['MeshHeading']){

        pkg.annotation = [];
        var graph = [];
        var hasBody = {
          "@type": ["Tag", "Mesh"],
          "@context": BASE + "/mesh.jsonld"
        };
        mesh[0]['MeshHeading'].forEach(function(x){
          var tmp = {
            "@type": "Heading",
          };
          if(x.DescriptorName){
            tmp.descriptor = {
              '@type': 'Record',
              name: x.DescriptorName[0]['_'],
              majorTopic: (x.DescriptorName[0]['$']['MajorTopicYN'] === 'Y')
            }
            if(x.QualifierName){
              tmp.qualifier = {
                '@type': 'Record',
                name: x.QualifierName[0]['_'],
                majorTopic: (x.QualifierName[0]['$']['MajorTopicYN'] === 'Y')
              }
            }
          }
          graph.push(tmp)
        });
        hasBody['@graph'] = graph;


        pkg.annotation.push({
          "@type": "Annotation",
          annotatedAt: pkg.article[0].datePublished,
          annotatedBy: {
            "@id": "http://www.ncbi.nlm.nih.gov/pubmed",
            "@type": "Organization",
            name: "PubMed"
          },
          serializedBy: {
            "@id": "http://standardanalytics.io",
            "@type": "Organization",
            name: "Standard Analytics IO"
          },
          serializedAt: (new Date()).toISOString(),
          motivatedBy: "oa:tagging",
          hasBody: [
            hasBody
          ],
          hasTarget: [
            {
              "@type": "SpecificResource",
              hasSource: "r/f9b634be34cb3f2af4fbf4395e3f24b3834da926",
              hasScope: pkg.name + '/' + pkg.version + '/article/' + pkg.article[0].name,
              hasState: {
                "@type": "HttpRequestState",
                value: "Accept: text/html"
              }
            }
          ]
        })
      }
    }


    var citations = [];
    var path = tools.findNodePaths(data,['CommentsCorrectionsList']);
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

  });

};
