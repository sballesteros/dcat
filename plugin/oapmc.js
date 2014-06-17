var request = require('request')
  , util = require('util')
  , fs = require('fs')
  , url = require('url')
  , async = require('async')
  , path = require('path')
  , temp = require('temp')
  , tar = require('tar')
  , once = require('once')
  , pubmed = require('./pubmed').pubmed
  , Client = require('ftp')
  , DecompressZip = require('decompress-zip')
  , zlib = require('zlib')
  , recursiveReaddir = require('recursive-readdir')
  , isUrl = require('is-url')
  , DOMParser = require('xmldom').DOMParser
  , XMLSerializer = require('xmldom').XMLSerializer
  , tools = require('./lib/tools');

temp.track();

module.exports = oapmc;

/**
 * 'this' is an Ldpm instance
 */
function oapmc(pmcid, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var that = this;

  fetchXml(pmcid, that, function(err, xml){
    if(err) return callback(err);
    
//    try {
      var meta = parseXml(xml, pmcid, opts);
//    }  catch(err){
//      return callback(err);
//    }

//    console.log(util.inspect(meta, {depth: null}));

    fetchTar(pmcid, that, function(err, files, mainArticleName){
      if(err) return callback(err);
//      console.log(files, mainArticleName);

    });

  });

};



function fetchXml(pmcid, ldpm, callback){
  var uri = 'http://www.pubmedcentral.nih.gov/oai/oai.cgi?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:' + pmcid.slice(3) + '&metadataPrefix=pmc';

  ldpm.logHttp('GET', uri);
  request(uri, function(error, resp, xml){
    if(error) return callback(error);

    ldpm.logHttp(resp.statusCode, uri);

    if(resp.statusCode >= 400){
      var err = new Error(xml);
      err.code = resp.statusCode;
      return callback(err);
    }

    callback(null, xml);
  });
};




/**
 * Cf. http://jats.nlm.nih.gov/archiving/tag-library/1.1d1/index.html
 */
function parseXml(xml, pmcid, opts){
  opts = opts || {};

  var doc = new DOMParser().parseFromString(xml, 'text/xml');
  
  var meta = {};
  var i;

  var $article = doc.getElementsByTagName('article')[0];

  var articleType = $article.getAttribute('article-type');
  if(articleType){
    meta.publicationType = articleType;
  }
  
  var $publisherName = $article.getElementsByTagName('publisher-name')[0];
  if($publisherName){
    meta.publisher = {
      '@type': 'Organization',
      name: $publisherName.textContent
    };
  }

  var $publisherLoc = $article.getElementsByTagName('publisher-loc')[0];
  if($publisherLoc){
    if(!meta.publisher){
      meta.publisher = {};
    }
    meta.publisher.location = {
      '@type': 'PostalAddress',
      description: tools.cleanText($publisherLoc.textContent)
    }
  }

  var $journalTitle = $article.getElementsByTagName('journal-title')[0];
  if($journalTitle){
    meta.journal = {
      '@type': 'Journal',
      name: tools.cleanText($journalTitle.textContent)
    }
  }

  //get journalShortName: will be used as a prefix of the pkg name => lover case, no space
  var $journalId = $article.getElementsByTagName('journal-id');
  for(i=0; i<$journalId.length; i++){
    var journalIdType = $journalId[i].getAttribute('journal-id-type');
    if(journalIdType === 'nlm-ta'){
      meta.journalShortName = $journalId[i].textContent.split(' ').map(function(x){return x.trim().replace(/\W/g, '').toLowerCase();}).join('-'); 
      break;
    }
  }

  if(!meta.journalShortName){
    if(meta.journal && meta.journal.name){
      meta.journalShortName = meta.journal.name.split(' ').map(function(x){return x.trim().replace(/\W/g, '').toLowerCase();}).join('-');
    } else {
      meta.journalShortName = '';
    }
  }

  var $issn = $article.getElementsByTagName('issn');
  if($issn){
    if(!meta.journal) meta.journal = {};
    for(i=0; i<$issn.length; i++){ //epub if possible because digital age
      meta.journal.issn = $issn[i].textContent;
      if($issn[i].getAttribute('pub-type') === 'epub'){
        break;
      }
    }
  }

  var $articleMeta = $article.getElementsByTagName('article-meta')[0];
  
  var $articleId = $articleMeta.getElementsByTagName('article-id');
  if($articleId){
    Array.prototype.forEach.call($articleId, function($el){
      var t = $el.getAttribute('pub-id-type');
      if(t === 'doi'){
        meta.doi = $el.textContent;
      } else if (t === 'pmid'){
        meta.pmid = $el.textContent;
      } else if (t === 'pmcid'){
        meta.pmcid = $el.textContent;
      }
    });
  }
  if(!meta.pmcid){
    meta.pmcid = pmcid; //always known -> can ensure pkg name in any case
  }

  var $articleCategories = $articleMeta.getElementsByTagName('article-categories');
  if($articleCategories){
    var keywords = [];
    Array.prototype.forEach.call($articleCategories, function($ac){
      Array.prototype.forEach.call($ac.childNodes, function($el){
        if($el.tagName === 'subj-group'){
          keywords = keywords.concat(_extractKeywords($el));
        }
      });
    });
    if(keywords.length){  
      meta.keywords = keywords; 
    }
  }

  var $articleTitle = $articleMeta.getElementsByTagName('article-title')[0];
  if($articleTitle){
    meta.title = tools.cleanText($articleTitle.textContent);
  }

  var $altTitle = $articleMeta.getElementsByTagName('alt-title')[0];
  if($altTitle){
    meta.shortTitle = $altTitle.textContent;
  }

  var affiliations = {}; // affiliations are generally defined independently of authors, with keys that the author spans point to.
  
  var $affs = $articleMeta.getElementsByTagName('aff');
  if($affs){

    Array.prototype.forEach.call($affs, function($aff){
      var id = $aff.getAttribute('id');
      if(!id) return;
      
      var affiliation = { '@type': 'Organization' };

      var desc = '';

      var $institution = $aff.getElementsByTagName('institution')[0];
      var $addrLine = $aff.getElementsByTagName('addr-line')[0];
      var $country = $aff.getElementsByTagName('country')[0];
      var $fax = $aff.getElementsByTagName('fax')[0];
      var $phone = $aff.getElementsByTagName('phone')[0];
      var $email = $aff.getElementsByTagName('email')[0];

      if($institution){
        affiliation.name = $institution.textContent;
        desc = affiliation.name + '. ';      
      }

      if($addrLine){
        desc += $addrLine.textContent + '. ';
      }

      if($country){
        affiliation.address = {
          '@type': 'PostalAddress',
          addressCountry: $country.textContent
        };
        desc += $country.textContent + '. ';
      }

      if($fax){
        affiliation.faxNumber = $fax.textContent;
      }

      if($phone){
        affiliation.telephone = $phone.textContent;
      }

      if($email){
        affiliation.email = $email.textContent;
      }

      if(desc){
        affiliation.description = tools.cleanText(desc);
      } else {

        //avoid label or sup in description...
        Array.prototype.forEach.call($aff.childNodes, function($el){
          if($el.tagName !== 'label' || $el.tagName !== 'sup'){
            if($el.nodeType === 3){
              desc += $el.nodeValue;
            } else if ($el.nodeType === 1){
              Array.prototype.forEach.call($el.childNodes, function($subEl){            
                if($el.nodeType === 3){
                  desc += $el.nodeValue
                }              
              });
            }
          }
        });

        if(desc){
          affiliation.description = tools.cleanText(desc);
        }
        
      }

      if(affiliations[id]){
        affiliations[id].push(affiliation);
      } else {
        affiliations[id] = [affiliation];
      }   

    }); 
  }

  var emails = {};
  var $authorNotes = $articleMeta.getElementsByTagName('author-notes');
  if($authorNotes){
    Array.prototype.forEach.call($authorNotes, function($el){
      var $corresp = $el.getElementsByTagName('corresp')[0];
      var id = $corresp.getAttribute('id');
      var $email = $corresp.getElementsByTagName('email')[0];

      if(id && $email){
        emails[id] = $email.textContent;
      }
    });
  }
  
  var author;
  var contributor = [];
  var accountablePerson = [];
  var editor = [];

  var $contribGroups = $articleMeta.getElementsByTagName('contrib-group');
  if($contribGroups){
    Array.prototype.forEach.call($contribGroups, function($contribGroup){
      var authCnt = 0;
      Array.prototype.forEach.call($contribGroup.childNodes, function($el){
        if($el.tagName === 'contrib'){
          var $contrib = $el;
          var contribType = $contrib.getAttribute('contrib-type');

          var $name = $contrib.getElementsByTagName('name')[0];
          if($name){
            var $givenNames = $name.getElementsByTagName('given-names')[0];
            if($givenNames){
              var givenName = $givenNames.textContent;
            }
            var $surname = $name.getElementsByTagName('surname')[0];
            if($surname){
              var familyName = $surname.textContent;
            }
          }

          var affiliation = [];
          var email;

          var corresp = !!($contrib.getAttribute('corresp') === 'yes');

          var $xrefs = $contrib.getElementsByTagName('xref');
          if($xrefs){
            Array.prototype.forEach.call($xrefs, function($xref){            
              var refType = $xref.getAttribute('ref-type');
              var rid = $xref.getAttribute('rid');

              if(refType === 'aff'){
                if(affiliations[rid]){
                  affiliation = affiliation.concat(affiliations[rid]);
                }
              } else if(refType === 'corresp'){
                if(emails[rid]){
                  email = emails[rid];
                }
                corresp = true;
              }
            });
          }

          var $email = $contrib.getElementsByTagName('email')[0];
          if($email){
            email = $email.textContent;
          }

          var person = { '@type': 'Person' };
          var tmpname = '';
          if(givenName){
            person.givenName = givenName;
            tmpname += givenName + ' ';
          }
          if(familyName){
            person.familyName = familyName;
            tmpname += familyName;
          }
          if(tmpname.length){
            person.name = tmpname;
          }
          if (email){
            person.email = email
          }
          if(affiliation.length){
            person.affiliation = affiliation;          
          }

          if(contribType === 'author'){

            if(authCnt++ === 0){
              author = person;
            } else {
              contributor.push(person);
            }

            if (corresp){
              accountablePerson.push(person);
            }

          } else if(contribType === 'editor'){

            editor.push(person);
            
          }

        }
      });
    });
  }

  meta.author = author;
  meta.contributor = contributor;
  meta.editor = editor;
  meta.accountablePerson = accountablePerson;

  //Grants are put in http://www.schema.org/sourceOrganization
  var sourceOrganisation = [];  

  //1- <funding-statement> without <funding-source> and without <award-id>
  var $fundingStatements = $article.getElementsByTagName('funding-statement');
  if($fundingStatements && $fundingStatements.length){
    Array.prototype.forEach.call($fundingStatements, function($fundingStatement){
      var isfundingSource = $fundingStatement.getElementsByTagName('funding-source')[0];
      var isAwardId = $fundingStatement.getElementsByTagName('award-id')[0];
      if(!isfundingSource || !isAwardId){
        sourceOrganisation.push({description: tools.cleanText($fundingStatement.textContent)});
      }
    });
  }

  //2- <funding-source> and <award-id> WITH id or rid
  var tmpGrant = {};

  var $fundingSources = $article.getElementsByTagName('funding-source');
  if($fundingSources && $fundingSources.length){
    Array.prototype.forEach.call($fundingSources, function($fundingSource){    
      var id = $fundingSource.getAttribute('id');
      var rid = $fundingSource.getAttribute('rid');
      var country = $fundingSource.getAttribute('country');
      if(id || rid){
        var s = { 
          '@type': 'Organization',
          'name': tools.cleanText($fundingSource.textContent) 
        };
        if(country){
          s.address = {'@type': 'PostalAddress', addressCountry: country };
        }
        tmpGrant[id || rid] = s;
      }      
    });
  }

  var $awardIds = $article.getElementsByTagName('award-id');
  if($awardIds && $awardIds.length){
    Array.prototype.forEach.call($awardIds, function($awardId){    
      var id = $awardId.getAttribute('id');
      var rid = $awardId.getAttribute('rid');
      if(id || rid){
        tmpGrant[id || rid]['grantId'] = tools.cleanText($awardId.textContent);
      }      
    });
  }

  for(var keyId in tmpGrant){
    sourceOrganisation.push(tmpGrant[keyId]);
  }

  //3- <funding-group> containing exactly 0 or 1 <funding-source> and <award-id> without id or rid.
  var $fundingGroups = $article.getElementsByTagName('funding-group');
  if($fundingGroups && $fundingGroups.length){
    Array.prototype.forEach.call($fundingGroups, function($fundingGroup){    
      var s = {};
      var $fundingSource = $fundingGroup.getElementsByTagName('funding-source');
      if($fundingSource && $fundingSource.length === 1 && !$fundingSource[0].getAttribute('id') && !$fundingSource[0].getAttribute('rid')){

        s['@type'] = 'Organization';
        s.name = tools.cleanText($fundingSource.textContent);
        var country = $fundingSource.getAttribute('country');
        if(country){
          s.address = {'@type': 'PostalAddress', addressCountry: country };
        }        
      }

      var $awardId = $fundingGroup.getElementsByTagName('award-id');
      if($awardId && $awardId.length === 1 && !$awardId[0].getAttribute('id') && !$awardId[0].getAttribute('rid')){
        s.grantId = tools.cleanText($awardId.textContent);
      }

      if(Object.keys(s).length){
        sourceOrganisation.push(s);
      }

    });    
  }

  if(sourceOrganisation.length){
    meta.sourceOrganisation = sourceOrganisation;
  }



  var $pubDate = $articleMeta.getElementsByTagName('pub-date');
  var jsDate;
  for(i=0; i<$pubDate.length; i++){
    var iso = $pubDate[i].getAttribute('iso-8601-date');
    
    if(iso){
      jsDate = new Date(iso);
    } else {
      var $day = $pubDate[i].getElementsByTagName('day')[0];
      var $month = $pubDate[i].getElementsByTagName('month')[0];
      var $year = $pubDate[i].getElementsByTagName('year')[0];

      if($year && $month && $day){
        jsDate = new Date($year.textContent, $month.textContent, $day.textContent);
      } else if($year && $month){
        jsDate = new Date($year.textContent, $month.textContent);
      } else if($year){
        jsDate = new Date($year.textContent);
      }
    }

    if($pubDate[i].getAttribute('pub-type') === 'epub' || $pubDate[i].getAttribute('publication-format') === 'electronic'){
      break;
    }
  }

  if(jsDate){
    meta.publicationDate = jsDate.toISOString(); //TODO fix timezone for bethesda DC because NLM
    meta.year = jsDate.getFullYear();
  }
  
  var $volume = $articleMeta.getElementsByTagName('volume')[0];
  if($volume){
    meta.volume = parseInt($volume.textContent, 10);
  }

  var $issue = $articleMeta.getElementsByTagName('issue')[0];
  if($issue){
    meta.issue = parseInt($issue.textContent, 10);
  }

  var $fpage = $articleMeta.getElementsByTagName('fpage')[0];
  if($fpage){
    meta.pageStart = parseInt($fpage.textContent, 10);
  }

  var $lpage = $articleMeta.getElementsByTagName('lpage')[0];
  if($lpage){
    meta.pageEnd = parseInt($lpage.textContent, 10);
  }

  var $pageCount = $articleMeta.getElementsByTagName('page-count')[0];
  if($pageCount){
    var pageCountCount = $pageCount.getAttribute('count');
    if(pageCountCount){
      meta.pageCount = parseInt(pageCountCount, 10);
    }    
  }

  var $copyrightYear = $articleMeta.getElementsByTagName('copyright-year')[0];
  if($copyrightYear){
    meta.copyrightYear = parseInt($copyrightYear.textContent, 10);
  }

  var $copyrightHolder = $articleMeta.getElementsByTagName('copyright-holder')[0];
  if($copyrightHolder){
    meta.copyrightHolder = $copyrightHolder.textContent;
  }

  var $license = $articleMeta.getElementsByTagName('license')[0];
  if($license){
    var licenseLink = $license.getAttribute('xlink:href');
    if(licenseLink){
      meta.license = licenseLink;
    } else {
      var $licenseP = $license.getElementsByTagName('license-p')[0];
      if($licenseP){
        meta.license = $licenseP.textContent;
      }
    }
  }


  //take into account possibility of different type of abstracts. 
  //TODO: structure
  var $abstracts = $articleMeta.getElementsByTagName('abstract');
  if($abstracts && $abstracts.length){
    meta.about = [];
    Array.prototype.forEach.call($abstracts, function($abstract){
      meta.about.push({
        name: $abstract.getAttribute('abstract-type') || 'abstract', 
        description: tools.cleanText($abstract.textContent)
      });
    });
  }


  //references

  var references = [];

  var $back = $article.getElementsByTagName('back')[0]; //http://jats.nlm.nih.gov/archiving/tag-library/1.1d1/index.html <back>Back Matter Back matter typically contains supporting material such as an appendix, acknowledgment, glossary, or bibliographic reference list.

  var $refList
  if($back){
    $refList = $back.getElementsByTagName('ref-list')[0];
  } else {
    $refList = $article.getElementsByTagName('ref-list')[0];
  }

  if($refList){
    var $refs = $refList.getElementsByTagName('ref');
    if($refs){
      Array.prototype.forEach.call($refs, function($ref){
        var ref = _getRef($ref);
        if(ref){
          references.push(ref);
        }
      });
    }
  }

  if(references.length){
    meta.references = references;
  }
 
  //add the caption from the extracted ```resources```
  meta.resources = findResources(doc); // finds the resources and their captions in the xml

  //inline content (get a list of ids)
  var inline = [];

  //inline-formula contain inline-graphic so no need to take special case of inline-formula into account
  var $inlineGraphics = $article.getElementsByTagName('inline-graphic');
  if($inlineGraphics && $inlineGraphics.length){
    Array.prototype.forEach.call($inlineGraphics, function($inlineGraphic){
      inline.push($inlineGraphic.getAttribute('xlink:href'));
    });
  }

  ['chem-struct-wrap', 'disp-formula'].forEach(function(inlineTag){
    var $els = $article.getElementsByTagName(inlineTag);
    if($els && $els.length){
      Array.prototype.forEach.call($els, function($el){
        var $graphic = $el.getElementsByTagName('graphic')[0];
        if($graphic){
          inline.push($graphic.getAttribute('xlink:href'));
        }
        var $media = $el.getElementsByTagName('graphic')[0];
        if($media){
          inline.push($media.getAttribute('xlink:href'));
        }
      });
    }
  });
  
  if(inline.length){
    meta.inline = inline;
  }

  return meta;
};


function _getRef($ref){
  
  var ref = {};

  var id = $ref.getAttribute('id');
  if(id){
    ref.name = id;
  }

  var $mixedCitation = $ref.getElementsByTagName('mixed-citation')[0];
  if($mixedCitation){

    ref.description = tools.cleanText($mixedCitation.textContent);

    var publicationType = $mixedCitation.getAttribute('publication-type');

    var $articleTitle = $mixedCitation.getElementsByTagName('article-title')[0];
    var $source = $mixedCitation.getElementsByTagName('source')[0];

    if(publicationType === 'journal'){
      ref['@type'] = 'ScholarlyArticle';
      if($articleTitle){
        ref.header = $articleTitle.textContent;
      }
      if($source){
        ref.journal = $source.textContent;
      }
    } else {
      if($source){
        ref.header = $source.textContent;
      }
    }

    var $volume = $mixedCitation.getElementsByTagName('volume')[0];
    if($volume){
      ref.volume = parseInt($volume.textContent, 10);
    }
    
    var $fpage = $mixedCitation.getElementsByTagName('fpage')[0];
    if($fpage){
      ref.pageStart = parseInt($fpage.textContent, 10);
    }

    var $lpage = $mixedCitation.getElementsByTagName('lpage')[0];
    if($lpage){
      ref.pageEnd = parseInt($lpage.textContent, 10);
    }
    
    var $day = $mixedCitation.getElementsByTagName('day')[0];
    var $month = $mixedCitation.getElementsByTagName('month')[0];
    var $year = $mixedCitation.getElementsByTagName('year')[0];

    var jsDate;
    if($year && $month && $day){        
      jsDate = new Date($year.textContent, $month.textContent, $day.textContent);
    } else if($year && $month){
      jsDate = new Date($year.textContent, $month.textContent);
    } else if($year){
      jsDate = new Date($year.textContent);
    }


    if(jsDate){
      try{
        ref.publicationDate = jsDate.toISOString();
      } catch(e){};
    }


    var $pubId = $mixedCitation.getElementsByTagName('pub-id')[0];
    if($pubId){
      var pubIdType = $pubId.getAttribute('pub-id-type');          
      if(pubIdType){ //doi, pmid...
        ref[pubIdType] = $pubId.textContent;
      }
    }

    //try again to get doi 
    if(!ref.doi){
      var $comment = $mixedCitation.getElementsByTagName('comment')[0];
      if($comment){
        var $extLinks = $comment.getElementsByTagName('ext-link');
        if($extLinks){
          Array.prototype.forEach.call($extLinks, function($extLink){
            var href = $extLink.getAttribute('xlink:href');
            if(href && isUrl(href)){
              var purl = url.parse(href);
              if(purl.host === 'dx.doi.org'){
                ref.doi = purl.pathname.replace(/^\//, '');
              }
            }
          });
        }
      }
    }        

    //try to get ref.url
    if(ref.doi){
      ref.url = 'http://dx.doi.org/' + ref.doi;
      if(ref.pmid){
        ref.sameAs = 'http://www.ncbi.nlm.nih.gov/pubmed/' + ref.pmid;
      }
    } else if(ref.pmid){
      ref.url = 'http://www.ncbi.nlm.nih.gov/pubmed/' + ref.pmid;
    } else {
      var $extLinks = $mixedCitation.getElementsByTagName('ext-link');
      if($extLinks){
        for(var i=0; i<$extLinks.length; i++){
          if($extLinks[i].getAttribute('ext-link-type') === 'uri'){
            var uriHref = $extLinks[i].getAttribute('xlink:href');
            if(uriHref && isUrl(uriHref)){
              ref.url = uriHref;
            }
          }
        }
      }
    }       

    //authors
    var $names = $mixedCitation.getElementsByTagName('name');
    if(!$names){
      $names = $mixedCitation.getElementsByTagName('string-name');
    }
    
    if($names){
      Array.prototype.forEach.call($names, function($name, i){
        var person = { '@type': 'Person' };
        var $surname = $name.getElementsByTagName('surname')[0];
        if($surname){
          person.familyName = $surname.textContent;
        }

        var $givenName = $name.getElementsByTagName('given-names')[0];
        if($givenName){
          person.givenName = $givenName.textContent;
        }

        if(i===0){
          ref.author = person;
        } else {
          if(!ref.contributor){
            ref.contributor = [];
          }
          ref.contributor.push(person);
        }

      });

      if($mixedCitation.getElementsByTagName('etal')[0]){
        ref.unnamedContributors = true; //indicates that more than the listed author and contributors.
      }
    }
  }

  if(Object.keys(ref).length){
    return ref;
  }
};



function _extractKeywords($el){
  var res = [];

  if($el.tagName === 'subj-group'){

    for(var i=0; i<$el.childNodes.length; i++){
      if($el.childNodes[i].tagName === 'subject'){
        res.push($el.childNodes[i].textContent);
      } else if ($el.childNodes[i].tagName === 'subj-group'){
        res = res.concat(_extractKeywords($el.childNodes[i]));          
      }
    }
    return res;

  } else if($el.tagName === 'subject') {      

    return [$el.textContent];

  }

  return res;
};


/**
 * find figure, tables, supplementary materials and their captions
 */ 
function findResources(doc){
  var resources = [];

  var tags = ['fig', 'table-wrap', 'supplementary-material'];

  tags.forEach(function(tag){

    Array.prototype.forEach.call(doc.getElementsByTagName(tag), function($el){
      var r = { 
        tag: tag,
        id: $el.getAttribute('id')
      };

      var $label = $el.getElementsByTagName('label')[0];      
      if($label){
        r.label = tools.cleanText($label.textContent);
      }
      if(r.label){
        if(r.label.match(/\d+$/)){
          r.num = r.label.match(/\d+$/)[0];
        }
      }

      var $caption = $el.getElementsByTagName('caption')[0];
      if($caption){
        r.caption = {};
        var $title = $caption.getElementsByTagName('title')[0];
        if($title){
          r.caption.title = tools.cleanText($title.textContent);
        }

        var $ps = $caption.getElementsByTagName('p');
        if($ps && $ps.length){
          r.caption.content = Array.prototype.map.call($ps, function($p){
            return tools.cleanText($p.textContent);
          }).join(' ');
          r.caption.content = tools.cleanText(r.caption.content);
        }
      }

      if(r.id === 'pone.0084949.s001'){
        var $objectIds = $el.getElementsByTagName('object-id');
        if($objectIds && $objectIds.length){
          r.ids = {};
          Array.prototype.forEach.call($objectIds, function($o){
            var pubIdType = $o.getAttribute('pub-id-type');
            if(pubIdType){
              r.ids[pubIdType] = tools.cleanText($o.textContent);
            }
          });
        }
      }


      if(tag === 'supplementary-material'){
        r.si = {
          id: $el.getAttribute('id'),
          mimetype: $el.getAttribute('mimetype'),
          mimeSubtype: $el.getAttribute('mime-subtype'),
          href: $el.getAttribute('xlink:href')
        }
      }
      
      //graphic and media      
      ['graphic', 'media'].forEach(function(mtag){
        var $mtags = $el.getElementsByTagName(mtag);
        if($mtags && $mtags.length){
          r[mtag] = [];
          Array.prototype.forEach.call($mtags, function($m){
            r[mtag].push({
              id: $m.getAttribute('id'),
              mimetype: $m.getAttribute('mimetype'),
              mimeSubtype: $m.getAttribute('mime-subtype'),
              href: $m.getAttribute('xlink:href')
            });            
          });
        }
      });

      //table (serialize the <table> element)
      var $table = $el.getElementsByTagName('table')[0];
      if($table){
        var serializer = new XMLSerializer();
        r.table = serializer.serializeToString($table);
      }

      //footnote
      var $fns = $el.getElementsByTagName('fn');
      if($fns && $fns.length){
        r.fn = [];
        Array.prototype.forEach.call($fns, function($fn){
          r.fn.push({
            id: $fn.getAttribute('id'),
            content: tools.cleanText($fn.textContent)
          });
        });
      }

      resources.push(r);
    });

  });

  return resources;
};


/**
 * return the list of files contained in the tar.gz of the article,
 * and move the relevant one (i.e non inline formula or co) into the current directory
 */
function fetchTar(pmcid, ldpm, callback){

  callback = once(callback);

  // Fetch XML doc containing URI of the tar.gz of the article
  var uri = 'http://www.pubmedcentral.nih.gov/utils/oa/oa.fcgi?id=' + pmcid;
  ldpm.logHttp('GET', uri);
  request(uri, function(error, response, oaContentBody){ 
    if(error) return callback(error);
    ldpm.logHttp(response.statusCode, uri);

    if(response.statusCode >= 400){
      var err = new Error(oaContentBody);
      err.code = response.statusCode;
      return callback(err);
    }

    //get URI of the tarball
    var doc = new DOMParser().parseFromString(oaContentBody, 'text/xml');
    var $links = doc.getElementsByTagName('link');

    try {
      var $linkTgz = Array.prototype.filter.call($links, function(x){return x.getAttribute('format') === 'tgz';})[0];
      var tgzUri = $linkTgz.getAttribute('href');
    } catch(e) {
      return callback(new Error('could not get tar.gz URI'));
    }

    var puri = url.parse(tgzUri);

    var root = ldpm.root;
    var c = new Client(); 
    c.connect({ host: puri.host });

    ldpm.logHttp('GET', tgzUri, 'ftp');
    c.on('ready', function() {
      temp.mkdir('__ldpmTmp', function(err, dirPath) {
        c.get(puri.path, function(err, stream) {
          if (err) return callback(err);
          ldpm.logHttp(200, tgzUri, 'ftp');

          stream = stream
            .pipe(zlib.Unzip())
            .pipe(tar.Extract({ path: dirPath, strip: 1 }));

          stream.on('error', callback);

          stream.on('end', function() {
            recursiveReaddir(path.resolve(dirPath), function (err, files) {
              if (err) return callback(err);

              c.end();

              var mainArticleName;

              // first way to get the name of the main article: from the pdf name in oaContentBody that contains pdf and tar.gz
              try {
                var $linkPdf = Array.prototype.filter.call($links, function(x){return x.getAttribute('format') === 'pdf';})[0];
                mainArticleName = url.parse($linkPdf.getAttribute('href')).pathname;
                mainArticleName = path.basename(mainArticleName, path.extname(mainArticleName));
                mainArticleName = mainArticleName.slice(0, mainArticleName.lastIndexOf('.')).replace(/ /g, '-'); //eg pone.0012255.PMC2924383 -> pone.0012255
              } catch(e){
                mainArticleName = undefined;
              }

              // Second way to get the name of the main article: from the name of the nxml file
              // in the tar.gz. OAPMC entries always have at least a pdf or an nxml.
              if(!mainArticleName){
                mainArticleName = extractNXMLName(files);
              }

              callback(null, files, mainArticleName);
            });
          });

        });
      });
    });
    
  });

};
