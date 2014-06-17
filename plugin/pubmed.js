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
function pubmed(pmid, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var that = this;

  var uri = 'http://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=' + pmid + '&rettype=abstract&retmode=xml';
  that.logHttp('GET', uri);
  request(uri, function(error,response, xml){
    if(error) return callback(error);

    that.logHttp(response.statusCode, uri)

    if(response.statusCode >= 400){
      var err = new Error(xml);
      err.code = response.statusCode;
      return callback(err);
    }

    try{
      var pkg = parseXml(xml, pmid);
    }  catch(err){
      return callback(err);
    }
    
    callback(null, pkg);
  });

};

/**
 * see http://www.nlm.nih.gov/bsd/licensee/elements_descriptions.html
 */ 
function parseXml(xml, pmid){

  var article =  { '@type': 'ScholarlyArticle', name: pmid, 'pmid': pmid };

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
      //Abstract can be structured => TODO RDFa with doco.
      //e.g PMID:19897313  http://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=19897313&rettype=abstract&retmode=xml

      var abstractTexts = []
      var $AbstractTexts = $Abstract.getElementsByTagName('AbstractText');
      if($AbstractTexts){
        Array.prototype.forEach.call($AbstractTexts, function($AbstractText){
          var about = {};
          var nlmCategory = $AbstractText.getAttribute('NlmCategory');
          if(nlmCategory){
            about.name = nlmCategory.trim().toLowerCase();
          }
          about.description = tools.cleanText($AbstractText.textContent);
          abstractTexts.push(about);
        });
      }
      if(abstractTexts.length){
        article.about = abstractTexts;
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
        } else {
          var $MedlineDate = $PubDate.getElementsByTagName('MedlineDate')[0];
          if($MedlineDate){
            try {
              jsDate = new Date(tools.cleanText($MedlineDate.textContent));
            } catch(e){}
          }
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

    //<Grant> as sourceOrganization (grantId is added TODO fix...)
    var sourceOrganizations = [];
    var $GrantList = $PubmedArticle.getElementsByTagName('GrantList')[0];
    if($GrantList){
      var $Grants = $GrantList.getElementsByTagName('Grant');
      if($Grants){
        Array.prototype.forEach.call($Grants, function($Grant){
          var $Agency = $Grant.getElementsByTagName('Agency')[0];
          var $GrantID = $Grant.getElementsByTagName('GrantID')[0];
          var $Country = $Grant.getElementsByTagName('Country')[0];
          
          if($Agency || $GrantID){
            var organization = { '@type': 'Organization' };
            if($Agency){
              organization.name = tools.cleanText($Agency.textContent);
            }
            if($GrantID){
              organization.grantId = tools.cleanText($GrantID.textContent);
            }
            if($Country){
              organization.address = {
                '@type': 'PostalAddress',
                'addressCountry': tools.cleanText($Country.textContent)
              }
            }
            sourceOrganizations.push(organization);
          }
        });
      }
    }

    if(sourceOrganizations.length){
      pkg.sourceOrganization = sourceOrganizations;
    }

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

    //dataset: <DataBankList> e.g pmid: 19237716
    var datasets = [];
    var $DataBankLists = $PubmedArticle.getElementsByTagName('DataBankList');
    if($DataBankLists){
      Array.prototype.forEach.call($DataBankLists, function($DataBankList){
        var $DataBanks = $DataBankList.getElementsByTagName('DataBank');
        if($DataBanks){
          Array.prototype.forEach.call($DataBanks, function($DataBank){
            var catalogName;
            var $DataBankName = $DataBank.getElementsByTagName('DataBankName')[0];
            if($DataBankName){
              catalogName = tools.cleanText($DataBankName.textContent);
            }

            if(catalogName){
              var $accessionNumberLists = $DataBank.getElementsByTagName('AccessionNumberList');
              if($accessionNumberLists){
                Array.prototype.forEach.call($accessionNumberLists, function($accessionNumberList){
                  var $accessionNumbers = $accessionNumberList.getElementsByTagName('AccessionNumber');
                  if($accessionNumbers){
                    Array.prototype.forEach.call($accessionNumbers, function($accessionNumber){
                      datasets.push({
                        name: tools.cleanText($accessionNumber.textContent),
                        catalog: { name: catalogName }
                      });
                    });
                  }
                });
              }             
            }           
          });
        }
      });    
    }
    if(datasets.length){
      pkg.dataset = datasets;
    }


    //Mesh: MeshHeading, [ MeshSupplementaryConcept, Mesh+Type whith Type [ Chemical, Protocol, Disease ] ]
    var meshGraph = [];
    var $MeshHeadingList = $PubmedArticle.getElementsByTagName('MeshHeadingList')[0];
    if($MeshHeadingList){
      var $MeshHeadings = $MeshHeadingList.getElementsByTagName('MeshHeading');
      if($MeshHeadings){        
        Array.prototype.forEach.call($MeshHeadings, function($MeshHeading){
          var meshHeading = { '@type': 'MeshHeading' };

          var $DescriptorName = $MeshHeading.getElementsByTagName('DescriptorName')[0];
          if($DescriptorName){
            meshHeading.descriptor = { 
              name: tools.cleanText($DescriptorName.textContent) ,
              majorTopic: ($DescriptorName.getAttribute('MajorTopicYN') === 'Y') ? true : false
            };
          }

          var $QualifierNames = $MeshHeading.getElementsByTagName('QualifierName');
          if($QualifierNames){
            var qualifiers = [];
            Array.prototype.forEach.call($QualifierNames, function($QualifierName){
              qualifiers.push({
                name: tools.cleanText($QualifierName.textContent) ,
                majorTopic: ($QualifierName.getAttribute('MajorTopicYN') === 'Y') ? true : false
              });
            });
            if(qualifiers.length){
              meshHeading.qualifier = qualifiers;
            }
          }
          
          meshGraph.push(meshHeading);          
        });

      }
    }

    //MeshSupplementaryConcept <SupplMeshList> (e.g 12416895)
    var $SupplMeshLists = $PubmedArticle.getElementsByTagName('SupplMeshList');
    if($SupplMeshLists){
      Array.prototype.forEach.call($SupplMeshLists, function($SupplMeshList){
        var $SupplMeshNames = $SupplMeshList.getElementsByTagName('SupplMeshName');
        if($SupplMeshNames){
          Array.prototype.forEach.call($SupplMeshNames, function($SupplMeshName){
            meshGraph.push({
              '@type': 'Mesh' + $SupplMeshName.getAttribute('Type'),
              name: tools.cleanText($SupplMeshName.textContent)
            });
          });
        }
      });    
    }

    //MeshSupplementaryConcept <ChemicalList> (e.g 12416895)
    var $ChemicalLists = $PubmedArticle.getElementsByTagName('ChemicalList');
    if($ChemicalLists){
      Array.prototype.forEach.call($ChemicalLists, function($ChemicalList){
        var $Chemicals = $ChemicalList.getElementsByTagName('Chemical');
        if($Chemicals){
          Array.prototype.forEach.call($Chemicals, function($Chemical){
            meshGraph.push({
              '@type': ['MeshChemical', 'Drug'], //rm http://schema.org/Drug ??
              name: tools.cleanText($Chemical.getElementsByTagName('NameOfSubstance')[0].textContent), 
              code: { //http://schema.org/MedicalCode
                '@type': 'MedicalCode',
                codeValue: tools.cleanText($Chemical.getElementsByTagName('RegistryNumber')[0].textContent) 
              } 
            });
          });
        }
      });    
    }


    if(meshGraph.length){
      //TODO add "annotatedAt", and "serializedAt"
      pkg.annotation = [
        {
          "@type": "Annotation",
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
          motivatedBy: "oa:tagging",
          hasBody: {
            "@type": ["Tag", "Mesh"],
            "@context": "mesh.jsonld",
            "@graph": meshGraph
          },
          hasTarget: [
            {
              "@type": "SpecificResource",
              hasSource: pkg.name + '/' + pkg.version + '/article/' + pkg.article[0].name,
            }
          ],
        }
      ];
    }
   
  }

  return pkg;
}
