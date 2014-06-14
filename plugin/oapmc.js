var request = require('request')
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
  , tools = require('./lib/tools');

process.maxTickDepth = 10000;
// to avoid warnings when using nextTick
// https://groups.google.com/forum/#!topic/nodejs/9_uM04IDNWg

temp.track();

module.exports = oapmc;

/**
 * 'this' is an Ldpm instance
 */
function oapmc(uri, opts, callback){

  callback = once(callback);

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var that = this;

  var puri = url.parse(uri, true);
  
  // check url
  if (puri.hostname === 'www.pubmedcentral.nih.gov' && puri.pathname === '/utils/oa/oa.fcgi' && puri.query.id){

    var pmcid = puri.query.id;

    // 0. Preliminary fetches
    that.logHttp('GET', uri);
    // Fetch the url of the tar.gz of the article
    request(uri, function(error, response, oaContentBody){
      if(error) return callback(error);

      that.logHttp(response.statusCode, uri);

      if(response.statusCode >= 400){
        var err = new Error(oaContentBody);
        err.code = response.statusCode;
        return callback(err);
      }

      var conversionUrl = 'http://www.pubmedcentral.nih.gov/utils/idconv/v1.0/?ids=' + pmcid + '&format=json';
      that.logHttp('GET', conversionUrl);
      // For PMC article, the idconv api returns {pmid,pmcid,doi} when given any of the three.
      request(conversionUrl, function(error, response, idConversionBody) {
        if(error) return callback(error);

        that.logHttp(response.statusCode,conversionUrl);

        if(response.statusCode >= 400){
          var err = new Error(idConversionBody);
          err.code = response.statusCode;
          return callback(err);
        }

        var res = JSON.parse(idConversionBody);
        var doi = res['records'][0]['doi'];
        var pmid = res['records'][0]['pmid'];
        if(pmid==undefined){
          // OAPMC entries do not all have a PMID (eg PMC3875093)
          opts.noPubmed = true;
        }

        // 1. Fetch : resources, xml, and pubmed metadata
        // a. resources

        //get URI of the tarball
        var doc = new DOMParser().parseFromString(oaContentBody, 'text/xml');
        var $links = doc.getElementsByTagName('link');

        try {
          var $linkTgz = Array.prototype.filter.call($links, function(x){return x.getAttribute('format') === 'tgz';})[0];
          var tgzUri = $linkTgz.getAttribute('href');
        } catch(e) {
          return callback(new Error('could not get tar.gz URI'));
        }
        
        fetchTar(tgzUri, that, function(err, files){
          if(err) return callback(err);

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

          // b. xml
          fetchXml('http://www.pubmedcentral.nih.gov/oai/oai.cgi?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:' + pmcid.slice(3) + '&metadataPrefix=pmc', that, function(err, xml){
            if(err) return callback(err);
            // c. pubmed metadata (if opts.noPubmed will callback immediately)
            fetchPubmedMetadata('http://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id='+pmid+'&rettype=abstract&retmode=xml', that, opts, function(err, pubmedPkg){
              if(err) return callback(err);

              // 2. Parse and complete pkg
              // a. resources: identify different encodings, substitute plos urls to contentPaths
              parseResources({}, files, doi, that, function(err, pkg){
                if(err) return callback(err);

                // b. xml: get captions, citations, authors, publishers etc from the xml

                try{
                  pkg = parseXml(xml, pkg, pmcid, mainArticleName, that, opts);
                }  catch(err){
                  return callback(err);
                }

                if(err) return callback(err);
                var artInd = tools.getArtInd(pkg, mainArticleName); // index of the main article in pkg.article

                // 3. Convert xml + pkg to html
                // a. two steps conversion of the xml articleBody: xml -> json -> html
                var jsonBody = xml2json(xml);

                tools.json2html(that, jsonBody, pkg, function(err, htmlBody){
                  if(err) return callback(err);

                  // b. if formulas have been inlined as base 64 in the text,
                  // they're removed from the pkg resources
                  removeInlineFormulas(pkg, that, function(err,pkg){
                    if(err) return callback(err);

                    // c. integrate the html article as a resource of the pkg
                    fs.writeFile(path.join(that.root, pkg.article[artInd].name + '.html'), htmlBody, function(err){
                      if(err) return callback(err);

                      that.paths2resources([path.join(that.root,pkg.article[artInd].name + '.html')], function(err,resources){
                        if(err) return callback(err);
                        if(pkg.article[artInd].encoding==undefined){
                          pkg.article[artInd].encoding = [];
                        }
                        pkg.article[artInd].encoding.push(resources.article[0].encoding[0]);

                        // d. extract pubmed annotations, adapt the target, and add to the pkg
                        tools.addPubmedAnnotations(pkg, pubmedPkg, that, function(err,pkg){
                          if(err) return callback(err);
                          callback(null, pkg);
                        });

                      });
                    });
                  });
                });
              });

            });
          });
        });


      });
    });

  } else {
    callback(new Error('unrecognized uri'));
  }

};


function extractNXMLName(files){

  for(var i=0; i<files.length; i++){
    if(path.extname(path.basename(files[i])) === '.nxml'){
      return path.basename(path.basename(files[i]), path.extname(path.basename(files[i]))).replace(/ /g, '-');
    }
  }

};

function fetchTar(tgzUri, ldpm, callback){
  // return the list of files contained in the tar.gz of the article,
  // and move them to the current directory

  callback = once(callback);

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

        stream.on('end', function() {
          recursiveReaddir(path.resolve(dirPath), function (err, files) {
            if (err) return callback(err);

            var newFiles = [];
            async.each(files, function(file,cb){

              var extname = path.extname(path.basename(file));
              var basename = path.basename(file, extname);
              var newpath = path.join(ldpm.root, basename.replace(/ /g, '-') + extname);              
              fs.rename(file, newpath, function(err){
                if(err) return cb(err);
                newFiles.push(newpath);
                cb(null);
              });

            }, function(err){
              if(err) return callback(err);
              c.end();
              return callback(null,newFiles);
            });

          });
        });
        stream.on('error', callback);
      })
    });
  });

};


function fetchXml(uri, ldpm, callback){
  ldpm.logHttp('GET', uri);
  request(uri, function(error, response, body){
    if(error) return callback(error);

    ldpm.logHttp(response.statusCode, uri);

    if(response.statusCode >= 400){
      var err = new Error(body);
      err.code = response.statusCode;
      return callback(err);
    }

    callback(null, body);
  });
};


function fetchPubmedMetadata(uri, ldpm, opts, callback){
  if(opts.noPubmed){
    callback(null, {});
  } else {
    // call to the pubmed plugin.
    // writeHTML: false prevents the pubmed plugin from writing to write
    // the html article it generates on the disk, to avoid conflicts with
    // the one generated by oapmc.
    pubmed.call(ldpm, uri, { writeHTML: false }, function(err, pubmedPkg){
      if(err) return callback(err);
      callback(null, pubmedPkg);
    });
  }
};


function parseResources(pkg, files, doi, ldpm, callback){
  callback = once(callback);

  var codeBundles = [];
  var compressedBundles = [];
  var typeMap = { 'figure': 'figure', 'audio': 'audio', 'video': 'video', 'code': 'targetProduct', 'dataset': 'distribution', 'article': 'encoding'};
  var toUnlink = [];

  // identify bundles
  var tmpAr = [];
  files.forEach(function(file,i){
    if(['.gz', '.gzip', '.tgz','.zip'].indexOf(path.extname(file))>-1){
      codeBundles.push(path.basename(file, path.extname(file)));
      compressedBundles.push(file);
    } else {
      tmpAr.push(file);
    }
  });
  files = tmpAr;


  var opts = { codeBundles: codeBundles };
  var ind = 0;

  async.each(compressedBundles, function(f, cb){
    cb = once(cb);
    // uncompress bundles
    if((path.extname(f) === '.tgz')||(path.extname(f) === '.gz')){
      var s = fs.createReadStream(path.join(ldpm.root, path.basename(f)));
      s = s.pipe(zlib.Unzip()).pipe(tar.Extract({ path: path.join(ldpm.root, path.basename(f, path.extname(f))) }));
      s.on('error',  cb);
      s.on('end', function() { cb(null); });
    } else if(path.extname(f)=='.zip') {
      var unzipper = new DecompressZip(f);
      unzipper.on('error', cb);
      unzipper.on('extract', function (log) { cb(null); });
      unzipper.extract({ path: path.join(ldpm.root, path.basename(f, path.extname(f))) });
    } else {
      zlib.unzip(f, cb);
    }
  }, function(err){
    if(err) return callback(err);

    var urls = [];
    var plosJournalsList = ['pone.','pbio.','pmed.','pgen.','pcbi.','ppat.','pntd.'];
    var plosJournalsLinks = {
      'pone.': 'http://www.plosone.org/article/info:doi/',
      'pbio.': 'http://www.plosbiology.org/article/info:doi/',
      'pmed.': 'http://www.Plasticine.org/article/info:doi/',
      'pgen.': 'http://www.plosgenetics.org/article/info:doi/',
      'pcbi.': 'http://www.ploscompbiol.org/article/info:doi',
      'ppat.': 'http://www.plospathogens.org/article/info:doi',
      'pntd.': 'http://www.plosntds.org/article/info:doi'
    };
    var tmpfiles = [];

    // generate potential valid urls if resources identified as plos resources
    files.forEach(function(f, i){
      var found = false;
      plosJournalsList.forEach(function(p, j){
        var basename = path.basename(f,path.extname(f));
        var extname = path.extname(f);
        basename = basename.replace(/ /g, '-');
        if( (basename.slice(0,p.length) === p) && (extname !== '.nxml') && (basename.split('.')[basename.split('.').length-1][0] !== 'e') ) {
          // note: figures which index starts with e (eg: pcbi.1000960.e001.jpg) are inline formulas. We don't bother
          // to test urls for them as they will be inlined.
          found = true;

          if( extname === '.pdf' ){
            var tmp = basename;
            tmp = '.'+tmp.split('.')[tmp.split('.').length-1];
            var tmpind = plosJournalsLinks[p].indexOf('info:doi');
            urls.push(plosJournalsLinks[p].slice(0,tmpind) + 'fetchObject.action?uri=info:doi/' + doi +  tmp.slice(0,tmp.lastIndexOf('.')) + '&representation=PDF');
          } else {
            var tmp = basename;
            tmp = '.' + tmp.split('.')[tmp.split('.').length - 1];
            var tmpind = plosJournalsLinks[p].indexOf('info:doi');
            urls.push(plosJournalsLinks[p].slice(0,tmpind) + 'fetchSingleRepresentation.action?uri=info:doi/' + doi +  tmp );
            if(['.gif', '.jpg', '.tif'].indexOf(extname) > -1){
              if(urls.indexOf(plosJournalsLinks[p] + doi +  tmp + '/' + 'powerpoint')==-1){
                urls.push(plosJournalsLinks[p] + doi +  tmp  + '/' + 'powerpoint');
                urls.push(plosJournalsLinks[p] + doi +  tmp  + '/' + 'largerimage');
                urls.push(plosJournalsLinks[p] + doi +  tmp  + '/' + 'originalimage');
              }
            }
          }
        }
      });
      if(!found){
        tmpfiles.push(f)
      }
    });

    var validatedurls = [];
    async.each(urls, function(uri, cb){
      // check which urls are valid

      ldpm.logHttp('HEAD', uri);
      request.head(uri, function (error, response, body) {
        if(error) return cb(error);
        ldpm.logHttp(response.statusCode, uri);
        if (response.statusCode == 200) {
          validatedurls.push(uri);
        }
        cb(null);
      });

    }, function(err){

      var files = tmpfiles;
      ldpm.paths2resources(files, opts, function(err, resources){
        if(err) return callback(err);
        ldpm.urls2resources(validatedurls, function(err, resourcesFromUrls){
          if(err) return callback(err);

          // plos resources need to be renamed: ldpm tools use the url basename while plos uses
          // that to specify the encoding
          ['figure','audio','video'].forEach(function(type){
            resourcesFromUrls[type].forEach(function(x){
              if(x.name.indexOf('SingleRepresentation')>-1){
                x.name = x[type][0].contentUrl.split('/')[x[type][0].contentUrl.split('/').length-1];
              } else if(x[type][0].contentUrl.indexOf('/powerpoint')>-1){
                x.name = x[type][0].contentUrl.split('/')[x[type][0].contentUrl.split('/').length-2];
              } else if(x[type][0].contentUrl.indexOf('/largerimage')>-1){
                x.name = x[type][0].contentUrl.split('/')[x[type][0].contentUrl.split('/').length-2];
              } else if(x[type][0].contentUrl.indexOf('/originalimage')>-1){
                x.name = x[type][0].contentUrl.split('/')[x[type][0].contentUrl.split('/').length-2];
              } else {
                x.name = x[type][0].contentUrl.split('/')[x[type][0].contentUrl.split('/').length-1];
              }
              if( (x.name.slice(0,8)==='journal.') || (x.name.slice(0,8)==='journal-') ){
                x.name = x.name.slice(8).replace(/ /g,'-');
              }
            })
          });

          resourcesFromUrls['code'].forEach(function(x){
            if(x.name.indexOf('SingleRepresentation')>-1){
              x.name = x['targetProduct'][0].contentUrl.split('/')[x[['targetProduct']][0].contentUrl.split('/').length-1].replace(/ /g,'-');
            } else {
              x.name = x[['targetProduct']][0].contentUrl.split('/')[x[['targetProduct']][0].contentUrl.split('/').length-2].replace(/ /g,'-');
            }
            if( (x.name.slice(0,8)==='journal.') || (x.name.slice(0,8)==='journal-') ){
              x.name = x.name.slice(8).replace(/ /g,'-');
            }
          });

          resourcesFromUrls['dataset'].forEach(function(x){
            if(x.name.indexOf('SingleRepresentation')>-1){
              x.name = x['distribution'][0].contentUrl.split('/')[x[['distribution']][0].contentUrl.split('/').length-1].replace(/ /g,'-');
            } else {
              x.name = x[['distribution']][0].contentUrl.split('/')[x[['distribution']][0].contentUrl.split('/').length-2].replace(/ /g,'-');
            }
            if( (x.name.slice(0,8)==='journal.') || (x.name.slice(0,8)==='journal-') ){
              x.name = x.name.slice(8).replace(/ /g,'-');
            }
          });

          resourcesFromUrls['article'].forEach(function(x){
            if(x.name.indexOf('fetchObject')>-1){
              x.name = x['encoding'][0].contentUrl.slice(0,x['encoding'][0].contentUrl.indexOf('&representation=PDF')).split('/')[x[['encoding']][0].contentUrl.split('/').length-1].replace(/ /g,'-');
            } else if(x['encoding'].indexOf("representation=PDF")>-1){
              x.name = x['encoding'][0].contentUrl.slice(0,x['encoding'][0].contentUrl.indexOf('&representation=PDF')).split('/')[x[['encoding']][0].contentUrl.split('/').length-2].replace(/ /g,'-');
            } else {
              x.name = x['encoding'][0].contentUrl.split('/')[x['encoding'][0].contentUrl.split('/').length-1].replace(/ /g,'-');
            }
            if( (x.name.slice(0,8)==='journal.') || (x.name.slice(0,8)==='journal-') ){
              x.name = x.name.slice(8).replace(/ /g,'-');
            }
          });

          //merge
          for (var type in resources){
            resources[type] = resources[type].concat(resourcesFromUrls[type]);
          }

          tmpAr = [];
          resources.dataset.forEach(function(x,i){
            if(!(path.extname(x.distribution[0].contentPath) === '.nxml')){ // remove the .nxml from pkg.dataset
              tmpAr.push(x);
            } else {
              toUnlink.push(path.join(ldpm.root,x.distribution[0].contentPath));
            }
          });
          resources.dataset = tmpAr;

          //TODO CHECK triple check splice because it affects length..
          // -> Jo: that's ok, ind2 incremented only when no splice.
          // merge resources that are different encodings of the same content
          ['figure','audio','video','code','article'].forEach(function(type){
            var ind=0;
            while(ind < resources[type].length){
              var ind2=ind+1;
              while(ind2 < resources[type].length){
                r2 = resources[type][ind2];
                if(resources[type][ind].name === r2.name && r2[type]){
                  resources[type][ind][typeMap[type]].push(r2[type][0]);
                  resources[type].splice(ind2, 1);
                } else {
                  ind2 +=1;
                }
              }
              ind += 1;
            }
          });

          // rm SingleRepresentation (PLOS) when there are alternatives
          ['figure','audio','video','code','article'].forEach(function(type){
            if(resources[type]){
              resources[type].forEach(function(r,i){
                tmpAr = [];
                r[typeMap[type]].forEach(function(x,i){
                  if(x.contentUrl != undefined){
                    if( !((x.contentUrl.indexOf('fetchSingleRepresentation')>-1) && (r[typeMap[type]].length>1)) ){
                      tmpAr.push(x);
                    }
                  } else {
                    tmpAr.push(x);
                  }
                });
                r[typeMap[type]] = tmpAr;
              });
            }
          });


          // create pkg
          var pkg = {};
          if(resources!=undefined){
            pkg = ldpm.addResources(pkg,resources);
          }

          // inline license and remove file
          var found = false;
          if(pkg.dataset){
            tmpAr = [];
            pkg.dataset.forEach(function(d,i){
              if(d.name === 'license'){
                found = true;
                fs.readFile(path.join(ldpm.root,d.distribution[0].contentPath), {encoding: 'utf8'}, function(err,txt){
                  if(err) return callback(err);
                  pkg.license = txt;
                  toUnlink.push(path.join(ldpm.root,d.distribution[0].contentPath));
                  async.each(toUnlink, fs.unlink, function(err){
                    if(err) return callback(err);
                    callback(null,pkg);
                  });
                });
              } else {
                tmpAr.push(d);
              }
            });
            pkg.dataset = tmpAr;
          }

          if(!found){
            async.each(toUnlink, fs.unlink, function(err){
              if(err) return callback(err);
              callback(null,pkg);
            });            
          }
        });
      });
    });
  });
};

function parseXml(xml, pkg, pmcid, mainArticleName, ldpm, opts){

  var artInd = tools.getArtInd(pkg, mainArticleName);
  if(artInd === -1){
    if(!pkg.article){
      pkg.article = [];
    }
    pkg.article.push({});
    artInd = pkg.article.length-1;
  }
  if(Array.isArray(pkg.article[artInd]['@type']) && pkg.article[artInd]['@type'].indexOf('ScholarlyArticle') === -1){
    pkg.article[artInd]['@type'].push('ScholarlyArticle');
  } else {
    pkg.article[artInd]['@type'] = 'ScholarlyArticle';
  }

  var doc = new DOMParser().parseFromString(xml, 'text/xml');

  var resources = findResources(doc); // finds the resources and their captions in the xml

  var meta = {};
  var i;

  var $article = doc.getElementsByTagName('article')[0];

  var articleType = $article.getAttribute('article-type');
  if(articleType){
    pkg.article[artInd].publicationType = articleType;
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
  meta.pmcid = pmcid; //always known -> can ensure pkg name in any case

  var $articleCategories = $articleMeta.getElementsByTagName('article-categories');
  if($articleCategories){
    var keywords = [];
    Array.prototype.forEach.call($articleCategories, function($ac){
      Array.prototype.forEach.call($ac.childNodes, function($el){
        if($el.tagName === 'subj-group'){
          keywords = keywords.concat(tools.extractKeywords($el));
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


  //TODO! funding and grants are put in http://www.schema.org/sourceOrganization
  //      var sourceOrganisation = [];


  var $pubDate = $articleMeta.getElementsByTagName('pub-date');
  var tmpDate;
  for(i=0; i<$pubDate.length; i++){
    var iso = $pubDate[i].getAttribute('iso-8601-date');
    
    if(iso){
      tmpDate = iso
    } else {
      var $day = $pubDate[i].getElementsByTagName('day')[0];
      var $month = $pubDate[i].getElementsByTagName('month')[0];
      var $year = $pubDate[i].getElementsByTagName('year')[0];
      if($year){
        meta.year = $year.textContent;
      }

      if($day && $month && $year){
        tmpDate = [$year.textContent, $month.textContent, $day.textContent].join('-');
      }
    }

    if($pubDate[i].getAttribute('pub-type') === 'epub' || $pubDate[i].getAttribute('publication-format') === 'electronic'){
      break;
    }
  }

  if(tmpDate){
    var jsDate = new Date(tmpDate);
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

  var $abstract = $articleMeta.getElementsByTagName('abstract')[0];
  if($abstract){
    meta.abstract = tools.cleanText($abstract.textContent);
  }

  //references
  var $back = $article.getElementsByTagName('back')[0]; //http://jats.nlm.nih.gov/archiving/tag-library/1.1d1/index.html <back>Back Matter Back matter typically contains supporting material such as an appendix, acknowledgment, glossary, or bibliographic reference list.

  var references = [];

  var $refList = $back.getElementsByTagName('ref-list')[0];
  if($refList){
    var $refs = $refList.getElementsByTagName('ref');
    if($refs){
      Array.prototype.forEach.call($refs, function($ref){
      
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
            ref.publicationDate = jsDate.toISOString();
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
          references.push(ref);
        }
      });
    }
  }

  if(references.length){
    meta.references = references;
  }

  //add extracted props from meta and resources to newPkg. We create a new Pkg to have control on the key order
  var newpkg = {};

  //idealy name pkg with (journal-)lastname-year
  var pkgName = [];

  if(meta.journalShortName){
    pkgName.push(meta.journalShortName);
  }

  if(meta.author && meta.author.familyName){
    pkgName.push(tools.removeDiacritics(meta.author.familyName.toLowerCase()).replace(/\W/g, ''));
  }

  if(meta.year){
    pkgName.push(meta.year);
  }

  if(pkgName.length>=2){
    newpkg.name = pkgName.join('-');
  } else {
    newpkg.name = pmcid;
  }

  newpkg.version = '0.0.0';

  if(meta.keywords && meta.keywords.length){
    newpkg.keywords = meta.keywords;
  }

  if(meta.title){
    newpkg.description = meta.title;
  }

  if(meta.license){
    newpkg.license = meta.license;
  } else if (pkg.license){
    newpkg.license = pkg.license;
  }

  if(!pkg.sameAs && meta.url){
    newpkg.sameAs = meta.url;
  }

  newpkg.author = meta.author;

  if(meta.contributor.length){
    newpkg.contributor =  meta.contributor;
  }

  newpkg.provider = {
    '@type': 'Organization',
    '@id': 'http://www.ncbi.nlm.nih.gov/pmc/',
    description: 'From PMC®, a database of the U.S. National Library of Medicine.'
  };

  if(meta.editor.length){
    if(Object.keys(meta.editor[0])){
      newpkg.editor = meta.editor;
    }
  }

  if(meta.publisher){
    newpkg.publisher = meta.publisher;
  }

  if(meta.journal){
    newpkg.journal = meta.journal;
  }

  newpkg.accountablePerson = {
    '@type': 'Organization',
    name: 'Standard Analytics IO',
    email: 'contact@standardanalytics.io'
  };


  if( meta.copyrightHolder ){
    newpkg.copyrightHolder = meta.copyrightHolder;
  } else if (meta.publisher) {
    newpkg.copyrightHolder = meta.publisher;
  }

  
  var typeMap = {
    'dataset': 'Dataset',
    'code': 'Code',
    'figure': 'ImageObject',
    'audio': 'AudioObject',
    'video': 'VideoObject',
    'article': 'Article'
  };

  //add the caption from the extracted ```resources```
  ['dataset', 'code', 'figure', 'audio', 'video', 'article'].forEach(function(type){
    if(pkg[type]) {
      pkg[type].forEach(function(r, i){
        if(!r.name){
          r.name = type + '-' + i;
        }

        if(!r['@type']){
          r['@type'] = typeMap[type];
        }

        if(meta.publicationDate){
          r.datePublished = meta.publicationDate;
        }

        resources.forEach(function(x){
          var potentialNames = [];
          if(x.id){
            potentialNames.push(x.id);
            potentialNames.push(x.id.replace(/ /g,'-'));            
            potentialNames.push(path.basename(x.id).replace(/ /g,'-'));
          }
          if(x.href){
            potentialNames.push(x.href);
            potentialNames.push(x.href.replace(/ /g,'-'));
            potentialNames.push(path.basename(url.parse(x.href).pathname).replace(/ /g,'-'));
          }
          
          if(potentialNames.indexOf(r.name) !==-1){
            var descr = '';
            if (x.label){
              descr = x.label + '. ';
            }
            if (x.caption){
              descr += x.caption;
            }

            descr = tools.cleanText(descr);

            if(descr){
              if(type === 'figure' || type === 'video'){
                r.caption = descr;
              } else {
                r.description = descr;
              }
            }

            if(x.alternateName){
              r.alternateName = x.alternateName;
            }
          }
        });

      });

      newpkg[type] = pkg[type];
            
      // delete resource types that have no entries.
      if(!newpkg[type].length){
        delete newpkg[type];
      }

    }
  });

  // in plos, figures have a doi. We reconstruct it.
  var plosJournalsList = ['pone', 'pbio', 'pmed', 'pgen', 'pcbi', 'ppat', 'pntd'];
  if(newpkg.figure && meta.doi){
    newpkg.figure.forEach(function(r){
      plosJournalsList.forEach(function(p){
        if(r.name.slice(0, p.length) === p){
          r.doi = meta.doi + '.' + r.name.split('-')[r.name.split('-').length-1];
        }
      });
    });
  }


  if ( artInd > -1){
    if(meta.accountablePerson){
      newpkg.article[artInd].accountablePerson = meta.accountablePerson;
    }
    if(meta.journal){
      newpkg.article[artInd].journal = meta.journal;
    }
    if(meta.doi){
      newpkg.article[artInd].doi = meta.doi;
    }
    if(meta.pmid){
      newpkg.article[artInd].pmid = meta.pmid;
    }
    if(meta.pmcid){
      newpkg.article[artInd].pmcid = meta.pmcid;
    }
    if(meta.title){
      newpkg.article[artInd].headline = meta.title;
    }
    if (meta.abstract){
      newpkg.article[artInd].abstract = meta.abstract;
    }
    if(meta.issue){
      newpkg.article[artInd].issue = meta.issue;
    }
    if(meta.volume){
      newpkg.article[artInd].volume = meta.volume;
    }
    if(meta.pageStart){
      newpkg.article[artInd].pageStart = meta.pageStart;
    }
    if(meta.pageEnd){
      newpkg.article[artInd].pageEnd = meta.pageEnd;
    }
    if(meta.references){
      newpkg.article[artInd].citation = meta.references;
    }
  }

  return newpkg;

};



function xml2json(xml){
  var doc = new DOMParser().parseFromString(xml,'text/xml');
  if(doc.getElementsByTagName('body').length){
    var body = doc.getElementsByTagName('body')[0];
  } else {
    var body = '<body>Emptybody</body>';//doc.getElementsByTagName('article')[0];
  }
  return tools.parseXmlNodesRec(body,xml);
};


function removeInlineFormulas(pkg, ldpm, callback){
  // We assume that figures corresponding to inline formulas have an identifier
  // starting with 'e' (plos convention)
  var plosJournalsList = ['pone','pbio','pmed','pgen','pcbi','ppat','pntd'];
  var tmpFigure = [];
  var toUnlink = [];

  if(pkg.figure){
    pkg.figure.forEach(function(fig){
      var keep = true;
      plosJournalsList.forEach(function(p,j){
        if(fig.name.slice(0,p.length)===p){
          if(fig.name.split('-')[fig.name.split('-').length-1].slice(0,1)==='e'){
            keep = false;
          }
        }
      })
      if(keep){
        tmpFigure.push(fig);
      } else {
        fig.figure.forEach(function(enc){
          toUnlink.push(path.resolve(ldpm.root,enc.contentPath));
        })
      }
    })
  }

  async.each(toUnlink, fs.unlink, function(err){
    if(err) return callback(err);
    pkg.figure = tmpFigure;
    if(pkg.figure.length==0){
      delete pkg.figure;
    }
    callback(null,pkg);
  });

};


function findResources(doc){
  // find figure, tables, supplementary materials and their captions
  var resources = [];

  var tags = ['fig', 'table-wrap', 'supplementary-material'];

  tags.forEach(function(tag){

    Array.prototype.forEach.call(doc.getElementsByTagName(tag), function(x){

      var r = {};

      if(x.getElementsByTagName('label')[0]){
        r.label = x.getElementsByTagName('label')[0].textContent;
      }
      if(r.label){
        if(r.label.match(/\d+$/)){
          r.num = r.label.match(/\d+$/)[0];
        }
      }
      if(x.getElementsByTagName('caption')[0]){
        r.caption = tools.cleanText(x.getElementsByTagName('caption')[0].textContent);
      }

      r.id = x.getAttribute('id');

      if(r.id){
        r.alternateName = r.id;
      }

      if(x.getElementsByTagName('graphic')[0]){
        r.href = x.getElementsByTagName('graphic')[0].getAttribute('xlink:href');
      }

      resources.push(r);
    });

  });

  return resources;
};

