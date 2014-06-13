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
  , xml2js = require('xml2js')
  , DecompressZip = require('decompress-zip')
  , zlib = require('zlib')
  , traverse = require('traverse')
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

              var pkg = { version: '0.0.0' };

              // 2. Parse and complete pkg
              // a. resources: identify different encodings, substitute plos urls to contentPaths
              parseResources(pkg, files, doi, that, function(err, pkg){
                if(err) return callback(err);

                // b. xml: get captions, citations, authors, publishers etc from the xml
                parseXml(xml, pkg, mainArticleName, that, opts, function(err, pkg){
                  if(err) return callback(err);
                  var artInd = tools.getArtInd(pkg); // index of the main article in pkg.article

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
          var pkg = { version: '0.0.0' };
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

function parseXml(xml, pkg, mainArticleName, ldpm, opts, callback){
  if(arguments.length === 5){
    callback = opts;
    opts = {};
  }

  callback = once(callback);

  var artInd = tools.getArtInd(pkg, mainArticleName);
  if(!artInd){
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
      description: $publisherLoc.textContent
    }
  }

  var $journalTitle = $article.getElementsByTagName('journal-title')[0];
  if($journalTitle){
    meta.journal = {
      '@type': 'Organization',
      name: $journalTitle.textContent
    }
  }

  //get journalShortName: will be used as a prefix of the pkg name => lover case, no space
  var $journalId = $article.getElementsByTagName('journal-id');
  for(i=0; i<$journalId.length; i++){
    var journalIdType = $journalId[i].getAttribute('journal-id-type');
    if(journalIdType === 'nlm-ta'){
      meta.journalShortName = $journalId[i].textContent.split(' ').map(function(x){return x.trim().replace(/\W/g, '').toLowerCase();}).join('-'); 
      console.log(meta.journalShortName);
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
        meta.pmid = $el.textContent;;
      } else if (t === 'pmcid'){
        meta.pmcid = $el.textContent;;
      }
    });
  }

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
    meta.title = $articleTitle.textContent;
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
        affiliation.description = desc;
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
          affiliation.description = desc;
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
      Array.prototype.forEach.call($contribGroup.childNodes, function($el, i){
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

            if(i==0){
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
    meta.publicationDate = (new Date(tmpDate).toISOString()); //TODO fix timezone for bethesda DC because NLM
  }


};


function parseXml_dep(xml, pkg, mainArticleName, ldpm, opts, callback){

  if(arguments.length === 5){
    callback = opts;
    opts = {};
  }

  callback = once(callback);

  var parser = new xml2js.Parser();
  var meta = {};
  var absPaths, relPaths;

  var resources = findResources(xml); // finds the resources and their captions in the xml

  var artInd = tools.getArtInd(pkg, mainArticleName);
  if(!artInd){
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

  parser.parseString(xml, function(err, xmlBody){
    if(err) return callback(error);

    // General strategy is to find paths for given tags using findNodePaths,
    // and then work on subtrees from these paths, extracted with traverse.
    // We work in two steps: we first parse and feed a ```meta``` object containing
    // relevant information, and then complete the pkg from ```meta```.

    absPaths = tools.findNodePaths(xmlBody, ['article', 'datestamp']);

    if(absPaths['datestamp']){
      meta.dateCreated = traverse(xmlBody).get(absPaths['datestamp'])[0];
    }
    
    if(absPaths['article']){
      var $data = traverse(xmlBody).get(absPaths['article'])[0];

      if($data['$']['article-type']){
        pkg.article[artInd].publicationType = $data['$']['article-type'].replace(/ /g, '-');
      }    

      absPaths = tools.findNodePaths($data, ['journal-meta', 'article-meta']);

      var $journalMeta = traverse($data).get(absPaths['journal-meta']);
      relPaths = tools.findNodePaths($journalMeta, ['publisher-name', 'publisher-loc', 'journal-title', 'journal-id', 'issn']);

      if(relPaths['publisher-name']){
        meta.publisher = {
          '@type': 'Organization',
          name: traverse($journalMeta).get(relPaths['publisher-name'])[0]
        };
      }

      if(relPaths['publisher-loc']){
        if(!meta.publisher){
          meta.publisher = {};
        }
        meta.publisher.location = {
          '@type': 'PostalAddress',
          description: traverse($journalMeta).get(relPaths['publisher-loc'])[0]
        }
      }

      if(relPaths['journal-title']){
        meta.journal = {
          '@type': 'Organization',
          name: traverse($journalMeta).get(relPaths['journal-title'])[0]
        }
      }

      //get journalShortName: will be used as a prefix of the pkg name => lover case, no space
      if(relPaths['journal-id']){
        traverse($journalMeta).get(relPaths['journal-id']).forEach(function(x,i){
          if(x['$']['journal-id-type'] === 'nlm-ta'){ //http://dtd.nlm.nih.gov/publishing/tag-library/n-3zr0.html NLM Title Abbreviation Identifier assigned by PubMed, for example, “Mol Biol Cell”, “Nucleic Acids Res”, etc.            
            meta.journalShortName = x['_'].split(' ').map(function(x){return x.trim().replace(/\W/g, '').toLowerCase();}).join('-');
            console.log(x['_'], meta.journalShortName);
          }
        });
      }

      if(!meta.journalShortName){
        if(meta.journal && meta.journal.name){
          meta.journalShortName = meta.journal.name.split(' ').map(function(x){return x.trim().replace(/\W/g, '').toLowerCase();}).join('-');
        } else {
          meta.journalShortName = '';
        }
      }

      if(relPaths['issn']){
        if(!meta.journal) meta.journal = {};
        meta.journal.issn = traverse($journalMeta).get(relPaths['issn'])[0]['_'];
      }

      var $articleMeta = traverse($data).get(absPaths['article-meta']);
      relPaths = tools.findNodePaths($articleMeta,
                                     [
                                       'article-id',
                                       'article-categories',
                                       'article-title',
                                       'alt-title',
                                       'aff',
                                       'author-notes',
                                       'contrib-group',
                                       'pub-date',
                                       'volume',
                                       'issue',
                                       'fpage',
                                       'lpage', 
                                       'permissions',
                                       'abstract',
                                       'page-count',
                                       'copyright-year',
                                       'copyright-holder',
                                       'copyright-statement',
                                       'license'
                                     ]
                                    );

      if(relPaths['article-id']){
        traverse($articleMeta).get(relPaths['article-id']).forEach(function(x,i){
          if(x['$']['pub-id-type'] === 'doi'){
            meta.doi = x['_'];
          } else if (x['$']['pub-id-type'] === 'pmid'){
            meta.pmid = x['_'];
          } else if (x['$']['pub-id-type'] === 'pmcid'){
            meta.pmcid = x['_'];
          }
        });
      }

      if(relPaths['article-categories']){
        var keywords = [];
        traverse($articleMeta).get(relPaths['article-categories']).forEach(function(x){
          if(x['subj-group']){
            x['subj-group'].forEach(function(sg){
              keywords = keywords.concat(tools.extractKeywords(sg));
            });
          }
        });
        meta.keywords = keywords;
      }


      if(relPaths['article-title']){
        if(typeof traverse($articleMeta).get(relPaths['article-title'])[0] === 'string'){
          meta.title = traverse($articleMeta).get(relPaths['article-title'])[0];
        } else {
          var doc = new DOMParser().parseFromString('<xml>' + tools.extractBetween(xml, '<article-title>', '</article-title>') + '</xml>', 'text/xml');
          meta.title = doc.lastChild.textContent;
        }
      }

      if(relPaths['alt-title']){
        meta.shortTitle = traverse($articleMeta).get(relPaths['alt-title'])[0]['_'];
      }

      var affiliations = {};
      // affiliations are generally defined independently of authors, with
      // keys that the author spans point to.
      if(relPaths['aff']){
        traverse($articleMeta).get(relPaths['aff']).forEach(function(x){

          if(x['$'] && x['$']['id']){
            var key = x['$']['id'];
          } else {
            return;
          }

          affiliations[key] =  [];
          var affiliation = { '@type': 'Organization' };

          var desc = '';

          if(x['institution']){
            affiliation.name = x['institution'][0];
            desc = x['institution'][0] + '. ';
          }

          if(x['addr-line']){
            desc += x['addr-line'][0] + '. ';
          }

          if(x['country']){
            affiliation.address = {
              '@type': 'PostalAddress',
              addressCountry: x['country'][0]
            };
            desc += x['country'][0] + '. ';
          }

          if(x['fax']){
            affiliation.faxNumber = x['fax'][0];
          }

          if(x['phone']){
            affiliation.telephone = x['phone'][0];
          }

          if(x['email']){
            affiliation.email = x['email'][0];
          }
          //TODO <ext-link ext-link-type="email" xlink:href="mailto:nuesslin@lrz.tum.de">


          if(desc!=''){

            affiliation.description = desc;
            affiliations[key].push(affiliation);

          } else {

            //TODO label in addition to sup e.g http://www.pubmedcentral.nih.gov/oai/oai.cgi?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:3532326&metadataPrefix=pmc
            if( (typeof x === 'object') && x['sup'] ){ //e.g  ldpm convert PMC2913510: http://www.pubmedcentral.nih.gov/oai/oai.cgi?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:2913510&metadataPrefix=pmc
              x.sup.forEach(function(s){
                affiliations[key].push({
                  '@type': 'Organization',
                  sup: parseInt(s, 10),
                  description: x._
                });
              });

            } else if (typeof x === 'object'){

              affiliations[key].push({
                '@type': 'Organization',
                description: x['_']
              });

            } else {

              affiliations[key].push({
                '@type': 'Organization',
                description: x
              });

            }

          }
        
        });
      }

      var emails = {};
      if(relPaths['author-notes']){
        traverse($articleMeta).get(relPaths['author-notes']).forEach(function(x){
          if(x['corresp']){
            if (x['corresp'][0]['$'] && x['corresp'][0]['$']['id']){
              if(x['corresp'][0]['email']){
                if(x['corresp'][0]['email'][0]['$']){
                  emails[x['corresp'][0]['$']['id']] = x['corresp'][0]['email'][0]['_'];
                } else {
                  emails[x['corresp'][0]['$']['id']] = x['corresp'][0]['email'][0];
                }
              }
            }
          }
        });
      }

      var author;
      var contributor = [];
      var accountablePerson = [];
      var editor = [];

      if(relPaths['contrib-group']){
        traverse($articleMeta).get(relPaths['contrib-group']).forEach(function(x){
          if(x.contrib){
            x.contrib.forEach(function(y, i){
              if(y.$['contrib-type'] === 'author'){

                var corresp = false;

                if(y['name']){
                  if(y['name'][0]['given-names'] && y['name'][0]['given-names'][0]){
                    var givenName = y['name'][0]['given-names'][0];
                  }
                  if(y['name'][0]['surname'] && y['name'][0]['surname'][0]){
                    var familyName = y['name'][0]['surname'][0];
                  }

                  var affiliation = [];
                  var email;

                  if(y.xref){
                    y.xref.forEach(function(z){
                      if(z['$']['ref-type']){
                        if (z['$']['ref-type'] == 'aff'){
                          if(affiliations[z['$']['rid']]){
                            if(z['sup']){
                              affiliations[z['$']['rid']].forEach(function(w){
                                if(!w.sup){
                                  affiliation.push(w);
                                } else {
                                  if(w.sup === z['sup'][0]){
                                    affiliation.push({ description : w.description });
                                  }
                                }
                              });
                            } else {
                              affiliation = affiliation.concat(affiliations[z['$']['rid']]);
                            }
                          }
                        } else if (z['$']['ref-type'] == 'corresp'){
                          if(emails[z['$']['rid']]){
                            email = emails[z['$']['rid']];
                          }
                          corresp = true;
                        }
                      }
                    });
                  }

                  if(y['email']){
                    email = y['email'][0]
                    if(y['$']['corresp']=='yes'){
                      corresp = true;
                    }
                  }


                  if(i==0){

                    author = { '@type': 'Person' };
                    var tmpname = '';
                    if(givenName){
                      author.givenName = givenName;
                      tmpname += givenName + ' ';
                    }
                    if(familyName){
                      author.familyName = familyName;
                      tmpname += familyName;
                    }
                    if(tmpname.length){
                      author.name = tmpname;
                    }
                    if (email){
                      author.email = email
                    }
                    if(affiliation.length){
                      if(affiliation[0]!={}){
                        author.affiliation = affiliation;
                      }
                    }

                  } else {

                    var tmpcontr = { '@type': 'Person' };
                    var tmpname = '';
                    if(givenName){
                      tmpcontr.givenName = givenName;
                      tmpname += givenName + ' ';
                    }
                    if(familyName){
                      tmpcontr.familyName = familyName;
                      tmpname += familyName;
                    }
                    if(tmpname.length){
                      tmpcontr.name = tmpname;
                    }
                    if(affiliation.length){
                      tmpcontr.affiliation = affiliation;
                    }
                    if(email){
                      tmpcontr.email = email;
                    }
                    contributor.push(tmpcontr);

                  }

                  if (corresp){
                    var tmpacc = { '@type': 'Person' };
                    var tmpname = '';
                    if(givenName){
                      tmpacc.givenName = givenName;
                      tmpname += givenName + ' ';
                    }
                    if(familyName){
                      tmpacc.familyName = familyName;
                      tmpname += familyName;
                    }
                    if(tmpname.length){
                      tmpacc.name = tmpname;
                    }
                    tmpacc.affiliation = affiliation;
                    if(email){
                      tmpacc.email = email;
                    }
                    accountablePerson.push(tmpacc);
                  }
                }

              } else if(y.$['contrib-type'] === 'editor'){
                if(y['name']){
                  if(y['name'][0]['given-names']){
                    var givenName = y['name'][0]['given-names'][0];
                  }
                  if(y['name'][0]['surname']){
                    var familyName = y['name'][0]['surname'][0];
                  }
                  var tmped = { '@type': 'Person' };
                  var tmpname = '';
                  if(givenName){
                    tmped.givenName = givenName;
                    tmpname += givenName + ' ';
                  }
                  if(familyName){
                    tmped.familyName = familyName;
                    tmpname += familyName;
                  }
                  if(tmpname.length){
                    tmped.name = tmpname;
                  }
                  var affiliation = [];
                  if(y.xref){
                    y.xref.forEach(function(z){
                      if (z['$']['ref-type'] == 'aff'){
                        affiliation.push( affiliations[z['$']['rid']][0] );
                      }
                    });
                  }
                  tmped.affiliation = affiliation;
                  editor.push(tmped);
                }
              };
            });
          }

        });
      }

      meta.author = author;
      meta.contributor = contributor;
      meta.editor = editor;
      meta.accountablePerson = accountablePerson;



      //funding and grants are put in http://www.schema.org/sourceOrganization
      //      var sourceOrganisation = [];
      //      meta.sourceOrganisation = sourceOrganisation;
      //TODO!

      


      //TODO fix: use <pub-date>
      var tmpDate = traverse($articleMeta).get(relPaths['year'])[0];
      if(relPaths['month']){
        tmpDate += '-'+ traverse($articleMeta).get(relPaths['month'])[0];
      }
      if(relPaths['day']){
        tmpDate += '-'+ traverse($articleMeta).get(relPaths['day'])[0];
      }
      meta.publicationDate = (new Date(tmpDate).toISOString());
      meta.year = traverse($articleMeta).get(relPaths['year'])[0];



      if(relPaths['volume']){
        meta.volume = parseInt(traverse($articleMeta).get(relPaths['volume'])[0],10);
      }
      if(relPaths['issue']){
        meta.issue = parseInt(traverse($articleMeta).get(relPaths['issue'])[0],10);
      }
      if(relPaths['fpage']){
        meta.pageStart = parseInt(traverse($articleMeta).get(relPaths['fpage'])[0],10);
      }
      if(relPaths['lpage']){
        meta.pageEnd = parseInt(traverse($articleMeta).get(relPaths['lpage'])[0],10);
      }
      if(relPaths['copyright-year']){
        meta.copyrightYear = traverse($articleMeta).get(relPaths['copyright-year'])[0];
      }
      if(relPaths['copyright-holder']){
        if(traverse($articleMeta).get(relPaths['copyright-holder'])[0]["$"]){
          meta.copyrightHolder = {
            description: traverse($articleMeta).get(relPaths['copyright-holder'])[0]['_']
          }
        } else {
          meta.copyrightHolder = {
            description: traverse($articleMeta).get(relPaths['copyright-holder'])[0]
          }
        }
      }

      if(relPaths['license']){
        if(traverse($articleMeta).get(relPaths['license'])[0]['$']){
          meta.license = traverse($articleMeta).get(relPaths['license'])[0]['$']['xlink:href'];
        }
      } else {
        if(relPaths['copyright-statement']){
          meta.license = traverse($articleMeta).get(relPaths['copyright-statement'])[0];
        }
      }

      if(relPaths['abstract']){
        if(xml.indexOf('<abstract>')>-1){
          meta.abstractHtml = tools.extractBetween(xml,'<abstract>','</abstract>');
          var doc = new DOMParser().parseFromString('<xml>'+ meta.abstractHtml + '</xml>', 'text/xml');
          meta.abstract = doc.lastChild.textContent.trim();
        }
      }

      if(relPaths['page-count']){
        meta.numPages = traverse($articleMeta).get(relPaths['page-count'])[0]['$']['count'];
      }

      references = [];
      
      if($data.back){ //http://jats.nlm.nih.gov/archiving/tag-library/1.1d1/index.html <back>Back Matter Back matter typically contains supporting material such as an appendix, acknowledgment, glossary, or bibliographic reference list.

        if($data.back[0]['ref-list']){

          if($data.back[0]['ref-list'][0]['ref'] != undefined){
            var reflist = $data.back[0]['ref-list'][0]['ref'];
          } else {
            var reflist = $data.back[0]['ref-list'][0]['ref-list'][0]['ref'];
          }

          reflist.forEach(function(x){

            Object.keys(x).forEach(function(k){
              if(k.indexOf('citation')>-1){
                y = x[k][0];
              }
            })

            var ref = {
              '@type':  'ScholarlyArticle' ,
              header: y['article-title']
            };

            if(relPaths['year']){
              ref.publicationDate = (new Date(traverse($articleMeta).get(relPaths['year'])[0])).toISOString();
            }

            if(x['$']){
              if(x['$']['id'] != undefined){
                ref.name = x['$']['id'];
              }
            }

            if(y['_']){
              delete ref['@type'];
              ref.description = y['_'];
            }

            if(y['ext-link'] && y['ext-link'][0]){
              if(y['ext-link'][0]['$'] && y['ext-link'][0]['$']['xlink:href']){
                ref.url = y['ext-link'][0]['$']['xlink:href'];
              } else if(y['ext-link'][0]['_']) {
                ref.url = y['ext-link'][0]['_'];
              }
            }

            ref.header = '';
            if(typeof y['article-title'] === 'string'){
              ref.header = y['article-title'];
            } else {
              var id = x['$']['id'];
              var tmp = tools.extractBetween(xml,'<ref id="'+id+'">','</ref>');
              if(tmp.indexOf('<article-title>')>-1){
                tmp = tools.extractBetween(tmp,'<article-title>','</article-title>');
                var doc = new DOMParser().parseFromString(
                  '<xml>'+
                    tmp+
                    '</xml>'
                  ,'text/xml');
                ref.header = doc.lastChild.textContent;
              } else if(y['source']){
                ref.header = y['source'];
              }
            }

            if(ref.header === ''){
              delete ref.header;
            }

            if( y['source']){
              ref.journal = y['source'][0],10;
            }
            if( y['volume']){
              ref.volume = parseInt(y['volume'][0],10);
            }
            if( y['fpage']){
              ref.pageStart = parseInt(y['fpage'][0],10);
            }
            if( y['lpage']){
              ref.pageEnd = parseInt(y['lpage'][0]);
            }
            if( y['comment']){
              y['comment'].forEach(function(y){
                if(typeof y != 'string'){
                  if(y['_'] == 'doi:'){
                    ref.doi = y['ext-link'][0]['_'];
                  }
                  if(y['_'] == 'pmid:'){
                    ref.pmid = y['ext-link'][0]['_'];
                  }
                }
              });
            }
            if(ref.doi === undefined){
              if(y['pub-id']){
                y['pub-id'].forEach(function(z){
                  if(z['$']['pub-id-type']=='doi'){
                    ref.doi = z['_'];
                  }
                  if(z['$']['pub-id-type']=='pmid'){
                    ref.pmid = z['_'];
                  }
                });
              }
            }

            if(ref.doi !== undefined){
              ref.url = 'http://doi.org/'+ref.doi;
              if(ref.pmid){
                ref.sameAs = 'http://www.ncbi.nlm.nih.gov/pubmed/?term=' + ref.pmid;
              }
            } else {
              if(ref.pmid){
                ref.url = 'http://www.ncbi.nlm.nih.gov/pubmed/?term=' + ref.pmid;
              }
            }

            //be sure URLs are URLs... for instance ldpm  convert PMC3237657 returns  'xlink:href': 'clinicaltrials.gov'
            if(!isUrl(ref.url)){
              delete ref.url;
            }

            var tmpName;
            if(y['name']){
              tmpName = y['name'];
            } else if (y['person-group']){
              tmpName = y['person-group'][0]['name'];
            }
            if(tmpName){
              tmpName.forEach(function(z,i){
                if(z['given-names']){
                  var givenName  = z['given-names'][0];
                }
                if(z['surname']){
                  var familyName = z['surname'][0];
                }
                var tmpauth = { '@type': 'Person' };
                var tmpname = '';
                if(givenName){
                  tmpauth.givenName = givenName;
                  tmpname += givenName + ' ';
                }
                if(familyName){
                  tmpauth.familyName = familyName;
                  tmpname += familyName;
                }
                if(tmpname.length){
                  tmpauth.name = tmpname;
                }
                if(i==0){
                  ref.author = tmpauth;
                } else {
                  if(ref.contributor == undefined){
                    ref.contributor = [];
                  }
                  ref.contributor.push(tmpauth);
                }
              });
            }

            var descr = '';

            if(ref.author){
              if(ref.author.familyName){
                descr += ref.author.familyName + ' ';
              }
              if(ref.author.givenName){
                descr += ref.author.givenName;
              }
            }
            if(ref.contributor){
              ref.contributor.forEach(function(x,i){
                if (i<4){
                  descr += ', ';
                  if(ref.author.familyName){
                    descr += x.familyName + ' ';
                  }
                  if(ref.author.givenName){
                    descr += x.givenName;
                  }
                } else if (i==5){
                  descr += ', et al.';
                }
              });
            }
            if(y['year']){
              descr += ' ('+y['year']+') ';
            }
            if(ref.header){
              descr += ref.header;
              if(ref.header[ref.header.length-1]!='.'){
                descr += '.';
              };
              descr += ' ';
            }
            if (ref.journal){
              descr += ref.journal + ' ';
            }
            if (ref.volume){
              descr += ref.volume + ': ';
            }
            if (ref.pageStart){
              descr += ref.pageStart;
            }
            if (ref.pageEnd){
              descr += '-'+ref.pageEnd;
            }
            descr += '.';
            if( (ref.description == undefined) || (ref.description.length<descr.length) ){
              ref.description = descr;
            }
            references.push(ref);
          });
        }
      }

      if(references.length){
        meta.references = references;
      }
    }

    // Phase 2: complete pkg.
    // note: to control the order of keys in objects, we reconstruct a new pkg from scratch
    // (object keys are theoretically unordered, but it's nicer when things show up with
    // consistent order)
    var newpkg = {};
    newpkg.name = '';
    if(meta.journalShortName){
      newpkg.name += meta.journalShortName;
    }
    if(meta.author){
      if(meta.author.familyName){
        newpkg.name += '-' + tools.removeDiacritics(meta.author.familyName.toLowerCase()).replace(/\W/g, '');
      }
    } else {
      newpkg.name += '-' + tools.removeDiacritics(meta.title.split(' ')[0].toLowerCase()).replace(/\W/g, '');
    }

    if(meta.year){
      newpkg.name += '-' + meta.year;
    } else {
      callback(new Error('did not find the year'));
    }

    newpkg.version = pkg.version;
    if(meta.dateCreated){
      newpkg.dateCreated = meta.dateCreated;
    }

    if(meta.keywords && meta.keywords.length){
      newpkg.keywords = meta.keywords;
    }
    if(meta.title){
      newpkg.description = meta.title;
    }
    newpkg.datePublished = (new Date()).toISOString();

    if(pkg.license != undefined){
      newpkg.license = pkg.license;
    } else {
      if(meta.license){
        newpkg.license = 'CC0-1.0';
      }
    }



    if(meta.url){
      newpkg.sameAs = meta.url;
    }

    newpkg.author =  meta.author;


    if(meta.contributor.length){
      newpkg.contributor =  meta.contributor;
    }


    newpkg.sourceOrganisation = [ {
      '@id': 'http://www.nlm.nih.gov/',
      '@type': 'Organization',
      name: 'National Library of Medecine',
      department: 'Department of Health and Human Services',
      address: {
        '@type': 'PostalAddress',
        addressCountry: 'US'
      }
    }]

    if(meta.sourceOrganisation.length){
      if(meta.sourceOrganisation[0] != {}){
        newpkg.sourceOrganisation = newpkg.sourceOrganisation.concat(meta.sourceOrganisation);
        newpkg.sourceOrganisation.forEach(function(y){
          if(y.address){
            y.address['@type'] = 'PostalAddress';
          }
        });
      }
    }

    newpkg.provider = {
      '@type': 'Organization',
      '@id': 'http://www.ncbi.nlm.nih.gov/pmc/',
      description: 'From PMC®, a database of the U.S. National Library of Medicine.'
    };

    if(meta.editor.length){
      if(meta.editor[0] != {}){
        newpkg.editor = meta.editor;
      }
    }

    if(meta.publisher){
      newpkg.publisher = meta.publisher;
      if(newpkg.publisher.location){
        newpkg.publisher.location['@type'] = 'PostalAddress';
      }
    }

    if(meta.journal){
      newpkg.journal = meta.journal;
      newpkg.journal['@type'] = 'Journal';
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
      'video': 'VideoObject'
    };

    ['dataset', 'code', 'figure', 'audio', 'video', 'article'].forEach(function(type){
      if (pkg[type] != undefined){
        pkg[type].forEach(function(x,i){
          if(x.name==undefined){
            x.name = type+'-'+i;
          }

          if(typeMap[type]){
            x['@type'] = typeMap[type];
          }

          if(meta.publicationDate){
            x.datePublished = meta.publicationDate;
          }

          pkg[type][i] = x;


          resources.forEach(function(fig){
            var v = [fig.id, fig.href];
            if(fig.id){
              v.push(fig.id.replace(/ /g,'-'));
            }
            if(fig.href){
              v.push(fig.href.replace(/ /g,'-'));
            }
            if( v.indexOf(x.name) > -1 ){
              var descr = '';
              if (fig.label){
                descr = fig.label + '. ';
              }
              if (fig.caption){
                descr += fig.caption;
                x.caption = descr;
              }
              if(fig.alternateName){
                x.alternateName = fig.alternateName;
              }
            }
          });

        });
      }
      newpkg[type] = pkg[type];
    });


    // in plos, figures have a doi. We reconstruct it.
    var plosJournalsList = ['pone-','pbio-','pmed-','pgen-','pcbi-','ppat-','pntd-'];
    if(newpkg.figure){
      newpkg.figure.forEach(function(x){
        plosJournalsList.forEach(function(p,j){
          if(x.name.slice(0,p.length)===p){
            x.doi = meta.doi + '.' + x.name.split('-')[x.name.split('-').length-1];
          }
        });
      });
    }


    if ( artInd > -1){
      if(meta.journal){
        pkg.article[artInd].journal = meta.journal;
      }
      if(meta.doi){
        pkg.article[artInd].doi = meta.doi;
      }
      if(meta.pmid){
        pkg.article[artInd].pmid = meta.pmid;
      }
      if(meta.pmcid){
        pkg.article[artInd].pmcid = meta.pmcid;
      }
      if(meta.title){
        pkg.article[artInd].headline = meta.title;
      }
      if (meta.abstract){
        pkg.article[artInd].abstract = meta.abstract;
      }
      if(meta.references){
        pkg.article[artInd].citation = meta.references;
      }
      if(meta.issue){
        pkg.article[artInd].issue = meta.issue;
      }
      if(meta.volume){
        pkg.article[artInd].volume = meta.volume;
      }
      if(meta.pageStart){
        pkg.article[artInd].pageStart = meta.pageStart;
      }
      if(meta.pageEnd){
        pkg.article[artInd].pageEnd = meta.pageEnd;
      }
    }

    // delete resource types that have no entries.
    ['dataset','code','figure','audio','video','article'].forEach(function(type){
      if(newpkg[type]){
        if(newpkg[type].length===0){
          delete newpkg[type];
        }
      }
    });
    callback(err,newpkg);

  })
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

      if(x.getElementsByTagName('label')[0]!=undefined){
        r.label = x.getElementsByTagName('label')[0].textContent;
      }
      if(r.label){
        if(r.label.match(/\d+$/)){
          r.num = r.label.match(/\d+$/)[0];
        }
      }
      if(x.getElementsByTagName('caption')[0] != undefined){
        r.caption = x.getElementsByTagName('caption')[0].textContent.replace(/\n/g,'').trim();
      }

      r.id = x.getAttribute('id');

      if(r.id){
        r.alternateName = r.id;
      }

      if(x.getElementsByTagName('graphic')[0] != undefined){
        r.href = x.getElementsByTagName('graphic')[0].getAttribute('xlink:href');
      } else {
        r.href = undefined
      }
      resources.push(r);
    });

  });

  return resources;
};
