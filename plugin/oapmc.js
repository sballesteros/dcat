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
  , crypto = require('crypto')
  , emitter = require('events').EventEmitter
  , events = require('events')
  , gm = require('gm')
  , tar = require('tar')
  , BASE = require('package-jsonld').BASE.replace('https','http')
  , once = require('once')
  , targz = require('tar.gz')
  , pubmed = require('./pubmed').pubmed
  , Client = require('ftp')
  , xml2js = require('xml2js')
  , DecompressZip = require('decompress-zip')
  , zlib = require('zlib')
  , traverse = require('traverse')
  , recursiveReaddir = require('recursive-readdir')
  , Ldpm = require('../index')
  , uuid = require('node-uuid')
  , DOMParser = require('xmldom').DOMParser;



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

  if (uri.slice(0,53)=='http://www.pubmedcentral.nih.gov/utils/oa/oa.fcgi?id=' ){
    // oa -> get pdf and tgz
    var pmcid = _extractBetween(uri,'PMC');
    var convurl = 'http://www.pubmedcentral.nih.gov/utils/idconv/v1.0/?ids='+'PMC'+pmcid+'&format=json';
    that.logHttp('GET', convurl);
    request(convurl, function(error, response, body) {
      that.logHttp(response.statusCode,convurl);
      var res = JSON.parse(response.body);
      if(res.status ==='ok'){
        var doi = res['records'][0]['doi'];
        _parseOAcontent(uri,doi,that,function(err,pkg,mainArticleName){
          if(err) return callback(err);
          uri = 'http://www.pubmedcentral.nih.gov/oai/oai.cgi?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:'+pmcid+'&metadataPrefix=pmc';
          _addMetadata(pkg,mainArticleName,uri,that,opts,function(err,pkg){
            if(err) return callback(err);
            callback(null,pkg);            
          });
        });
      } else {
        var err = new Error('this identifier does not belong to the Open Access subset of Pubmed Central');
        err.code = 404; 
        callback(err);
      }
    });
  } else {
    callback(new Error('unrecognized uri'));
  }

};


function _parseOAcontent(uri,doi,that,cb){

  callback = once(cb);

  that.logHttp('GET', uri);

  request(uri, function (error, response, body) {
    that.logHttp(response.statusCode,uri);

    if(error) return cb(error);
    if(body.indexOf('idDoesNotExist')>-1){
      var err = new Error('this identifier does not belong to the Open Access subset of Pubmed Central');
      err.code = 404; 
      return cb(err);
    }

    if(body.indexOf('format="tgz"')>-1){
      _fetchTar(body,that, function(err, files){
        if(err) return cb(err);
        _fetchPdfName(body, function(err,mainArticleName){
          if(err) return cb(err);
          var codeBundles = [];
          var compressedBundles = [];
          files.forEach(function(file,i){
            if(['.gz', '.gzip', '.tgz','.zip'].indexOf(path.extname(file))>-1){
              codeBundles.push(path.basename(file,path.extname(file)));
              compressedBundles.push(file);
              files.splice(i,1);
            }
          })
          var opts = { codeBundles: codeBundles };
          var ind = 0;
          async.each(compressedBundles,
            function(f,cb){
              if(path.extname(f)=='.tgz'){
                gzip = new targz();
                gzip.extract(path.join(that.root,f),path.join(that.root,path.basename(f,path.extname(f))), function(err) {
                  return cb(err);
                });
              } else if(path.extname(f)=='.zip') {
                 unzipper = new DecompressZip(f);
                 unzipper.on('error', function (err) {
                   return cb(err);
                 });
                 unzipper.on('extract', function (lob) {
                   return cb(null);
                 });
                 unzipper.extract({ path: path.join(that.root,path.basename(f,path.extname(f))) });
              } else {
                zlib.unzip(f, cb);
              }
            },
            function(err){
              if(err) return cb(err);
              var urls = [];
              var plosJournalsList = ['pone.','pbio.','pmed.','pgen.','pcbi.','ppat.','pntd.'];
              var plosJournalsLinks = {
                'pone.': 'http://www.plosone.org/article/info:doi/',
                'pbio.': 'http://www.plosbiology.org/article/info:doi/',
                'pmed.': 'http://www.plosmedicine.org/article/info:doi/',
                'pgen': 'http://www.plosgenetics.org/article/info:doi/',
                'pcbi': 'http://www.ploscompbiol.org/article/info:doi',
                'ppat': 'http://www.plospathogens.org/article/info:doi',
                'pntd': 'http://www.plosntds.org/article/info:doi'
              }
              var tmpfiles = [];

              files.forEach(function(f,i){
                var found = false;
                plosJournalsList.forEach(function(p,j){
                  if( (path.basename(f).slice(0,p.length)===p) && (path.extname(f) != '.nxml') && (f.split('.')[f.split('.').length-2][0] != 'e') ) {
                    found = true;
                    
                    if( path.extname(f) === '.pdf' ){
                      var tmp = path.basename(f,path.extname(f));
                      tmp = '.'+tmp.split('.')[tmp.split('.').length-1];
                      var tmpind = plosJournalsLinks[p].indexOf('info:doi');
                      urls.push(plosJournalsLinks[p].slice(0,tmpind) + 'fetchObject.action?uri=info:doi/' + doi +  tmp.slice(0,tmp.lastIndexOf('.')) + '&representation=PDF');                      
                    } else {
                      var tmp = path.basename(f,path.extname(f));
                      tmp = '.'+tmp.split('.')[tmp.split('.').length-1];
                      var tmpind = plosJournalsLinks[p].indexOf('info:doi');
                      urls.push(plosJournalsLinks[p].slice(0,tmpind) + 'fetchSingleRepresentation.action?uri=info:doi/' + doi +  tmp );
                      if(['.gif','.jpg','.tif'].indexOf(path.extname(f))>-1){
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
              async.each(urls,
                function(uri,cb2){
                  // check which urls are valid
                  request(uri, function (error, response, body) {
                    if (!error && response.statusCode == 200) {
                      validatedurls.push(uri);
                    }
                    cb2(null);
                  });
                },
                function(err){
                  files = tmpfiles;
                  that.paths2resources(files,opts, function(err,resources){
                    if(err) return cb(err);
                    that.urls2resources(validatedurls, function(err,resourcesFromUrls){
                      if(err) return cb(err);

                      // rename
                      ['figure','audio','video'].forEach(
                        function(type){
                          resourcesFromUrls[type].forEach(
                            function(x){
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
                              if(x.name.slice(0,8)==='journal.'){
                                x.name = x.name.slice(8);
                              }
                            }
                          )
                        }
                      );
  
                      resourcesFromUrls['code'].forEach(
                        function(x){
                          if(x.name.indexOf('SingleRepresentation')>-1){
                            x.name = x['targetProduct'][0].contentUrl.split('/')[x[['targetProduct']][0].contentUrl.split('/').length-1];                                
                          } else {
                            x.name = x[['targetProduct']][0].contentUrl.split('/')[x[['targetProduct']][0].contentUrl.split('/').length-2];
                          }
                          if(x.name.slice(0,8)==='journal.'){
                            x.name = x.name.slice(8);
                          }
                        }
                      );

                      resourcesFromUrls['dataset'].forEach(
                        function(x){
                          if(x.name.indexOf('SingleRepresentation')>-1){
                            x.name = x['distribution'][0].contentUrl.split('/')[x[['distribution']][0].contentUrl.split('/').length-1];                                
                          } else {
                            x.name = x[['distribution']][0].contentUrl.split('/')[x[['distribution']][0].contentUrl.split('/').length-2];
                          }
                          if(x.name.slice(0,8)==='journal.'){
                            x.name = x.name.slice(8);
                          }
                        }
                      );

                      resourcesFromUrls['article'].forEach(
                        function(x){
                          if(x.name.indexOf('fetchObject')>-1){
                            x.name = x['encoding'][0].contentUrl.slice(0,x['encoding'][0].contentUrl.indexOf('&representation=PDF')).split('/')[x[['encoding']][0].contentUrl.split('/').length-1];                                
                          } else if(x['encoding'].indexOf("representation=PDF")>-1){
                            x.name = x['encoding'][0].contentUrl.slice(0,x['encoding'][0].contentUrl.indexOf('&representation=PDF')).split('/')[x[['encoding']][0].contentUrl.split('/').length-2];
                          } else {
                            x.name = x['encoding'][0].contentUrl.split('/')[x['encoding'][0].contentUrl.split('/').length-1];
                          }
                          if(x.name.slice(0,8)==='journal.'){
                            x.name = x.name.slice(8);
                          }
                        }
                      );

                      // find .nxml file and push it into article
                      if(err) return cb(err);
                      for (var type in resources){
                        resources[type] = resources[type].concat(resourcesFromUrls[type]); //merge
                      }
                      var pushed = false;
                      if(mainArticleName!=undefined){
                        resources.dataset.forEach(function(x,i){
                          if(x.name===path.basename(mainArticleName,'.pdf').slice(0,path.basename(mainArticleName,'.pdf').lastIndexOf('.'))){
                            resources.dataset.splice(i,1);
                            resources.article.forEach(function(y,i){
                              if( (x.name==y.name) && (!pushed) ){
                                var tmp = y.encoding ;
                                tmp.push(x.distribution[0]);
                                resources.article[i].encoding = tmp;
                                pushed = true;
                              }
                            });
                          }
                        });
                      } else {
                        resources.dataset.forEach(function(x,i){
                          if(path.ext(x.distribution.contentPath) == 'nxml'){
                            resources.dataset.splice(i,1);
                            resources.article.push(x);
                            mainArticleName = x.name;
                          }
                        });
                      }
                      
                      ['figure','audio','video'].forEach(
                        function(type){
                          var ind=0;
                          while(ind<resources[type].length){
                            var ind2=ind+1;
                            while(ind2<resources[type].length){
                              r2 = resources[type][ind2];
                              if(resources[type][ind].name===r2.name){
                                resources[type][ind][type].push(r2[type][0]);
                                resources[type].splice(ind2,1);
                              } else {
                                ind2+=1;
                              }
                            }
                            ind += 1;
                          }
                        }
                      );

                      resources['code'].forEach(
                        function(r,i){
                          resources['code'].slice(i+1,resources['code'].length).forEach(
                            function(r2,j){
                              if(r.name===r2.name){
                                r['targetProduct'].push(r2['targetProduct'][0]);
                                resources['code'].splice(i+j+1,1);
                              }
                            }
                          )
                        }
                      );

                      resources['article'].forEach(
                        function(r,i){
                          resources['article'].slice(i+1,resources['article'].length).forEach(
                            function(r2,j){
                              if(r.name===r2.name){
                                r['encoding'].push(r2['encoding'][0]);
                                resources['article'].splice(i+j+1,1);
                              }
                            }
                          )
                        }
                      );

                      // rm SingleRepresentation (PLOS) when there are alternatives
                      ['figure','audio','video'].forEach(
                        function(type){
                          if(resources[type]){
                            resources[type].forEach(
                              function(r,i){
                                r[type].forEach(
                                  function(x,i){
                                    if(x.contentUrl != undefined){
                                      if( (x.contentUrl.indexOf('fetchSingleRepresentation')>-1) && (r[type].length>1) ){
                                        r[type].splice(i,1); 
                                      }
                                    }
                                  }
                                )
                              }
                            )
                          }
                        }
                      )
                      if(resources['code']){
                        resources['code'].forEach(
                          function(r,i){
                            r['targetProduct'].forEach(
                              function(x,i){
                                if(x.contentUrl != undefined){
                                  if( (x.contentUrl.indexOf('fetchSingleRepresentation')>-1) && (r['targetProduct'].length>1) ){
                                    r['targetProduct'].splice(i,1); 
                                  }
                                }
                              }
                            )
                          }
                        )
                      } 
                      if(resources['dataset']){
                        resources['dataset'].forEach(
                          function(r,i){
                            r['distribution'].forEach(
                              function(x,i){
                                if(x.contentUrl != undefined){
                                  if( (x.contentUrl.indexOf('fetchSingleRepresentation')>-1) && (r['distribution'].length>1) ){
                                    r['distribution'].splice(i,1); 
                                  }
                                }
                              }
                            )
                          }
                        )
                      }

                      var pkg = _initPkg();
                      if(resources!=undefined){
                        pkg = that.addResources(pkg,resources);
                      }

                      var found = false;
                      pkg.dataset.forEach(function(d,i){
                        if(d.name==='license'){
                          found = true;
                          fs.readFile(path.join(that.root,d.distribution[0].contentPath),function(err,txt){
                            if(err) return cb(err);
                            pkg.license = txt.toString();
                            pkg.dataset.splice(i,1);
                            fs.unlink(path.join(that.root,d.distribution[0].contentPath), function(err){
                              if(err) return cb(err);
                              cb(null,pkg,mainArticleName);
                            });
                          })
                        }
                      })
                      if(!found){
                        cb(null,pkg,mainArticleName);
                      }
                    });
                  });
                }
              );
            }
          )
        });
      });
    }
  });

}


function _fetchTar(body,ldpm,callback){
  var root = ldpm.root;
  var href = _extractBetween(body,'href="','"');
  var c = new Client();

  ldpm.logHttp('GET', href.slice(27));
  c.on('ready', function() {
    temp.track();
    temp.mkdir('__ldpmTmp',function(err, dirPath) {
      c.get(href.slice(27), function(err, stream) {
        if (err) return callback(err);
        var fname = '/' + dirPath.split('/')[dirPath.split('/').length-1];
        stream.once('close', function() {
          ldpm.logHttp(200, href.slice(27));
          recursiveReaddir(path.resolve(dirPath), function (err, files) {
            if (err) return callback(err);
            var newFiles = [];
            async.each(files,
              function(file,cb){
                newFiles.push(path.join(ldpm.root,path.basename(file)));

                var rd = fs.createReadStream(file);
                rd.on("error", function(err) {
                  done(err);
                });
                var wr = fs.createWriteStream(path.join(ldpm.root,path.basename(file)));
                wr.on("error", function(err) {
                  done(err);
                });
                wr.on("close", function(ex) {
                  done();
                });
                rd.pipe(wr);                                                                                                                                                    

                function done(err) {
                  if(err) return cb(err);
                  return cb(null);
                }

              },
              function(err){
                if(err) return callback(err);
                c.end(); 
                return callback(null,newFiles);
              }
            )
          });
        });
        stream.on('error',function(err){
          return callback(err);
        });
        stream
          .pipe(zlib.Unzip())
          .pipe(tar.Extract({ path: dirPath, strip: 1 }));        
      })      
    });
  });
  c.connect({ host: 'ftp.ncbi.nlm.nih.gov' });

}

function _fetchPdfName(body,callback){
  var tmp = _extractBetween(body,'format="pdf"');
  var href = _extractBetween(tmp,'href="','"');
  callback(null,path.basename(href.slice(6)));
}


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
      paths[this.key] = this.path;
    }
  });
  return paths;
}

function _findFigures(xmlBody){
  var doc = new DOMParser().parseFromString(xmlBody,'text/xml');
  var figures = [];
  Array.prototype.forEach.call(doc.getElementsByTagName('fig'),function(x){
    var fig = {};
    Array.prototype.forEach.call(x.attributes, function(att){
      if(att.name==='id'){
        fig.alternateName = att.value;
      }
    })
    if(x.getElementsByTagName('label')[0]!=undefined){
      fig.label = x.getElementsByTagName('label')[0].textContent;
    }
    if(fig.label){
      if(fig.label.match(/\d+$/)){
        fig.num = fig.label.match(/\d+$/)[0];
      }
    }
    if(x.getElementsByTagName('caption')[0] != undefined){
      fig.caption = x.getElementsByTagName('caption')[0].textContent.replace(/\n/g,'').trim();
    }
    fig.id = x.getAttribute('id');
    if(x.getElementsByTagName('graphic')[0] != undefined){
      fig.href = x.getElementsByTagName('graphic')[0].getAttribute('xlink:href');
    } else {
      fig.href = undefined
    }
    figures.push(fig);
  });
  Array.prototype.forEach.call(doc.getElementsByTagName('table-wrap'),function(x){
    var fig = {};
    if(x.getElementsByTagName('label')[0]!=undefined){
      fig.label = x.getElementsByTagName('label')[0].textContent;
    }
    if(fig.label){
      if(fig.label.match(/\d+$/)){
        fig.num = fig.label.match(/\d+$/)[0];
      }
    }
    if(x.getElementsByTagName('caption')[0] != undefined){
      fig.caption = x.getElementsByTagName('caption')[0].textContent.replace(/\n/g,'').trim();
    } else if (x.getElementsByTagName('title')[0] != undefined){
      fig.caption = x.getElementsByTagName('title')[0].textContent.replace(/\n/g,'').trim();
    }
    fig.id = x.getAttribute('id');
    if(x.getElementsByTagName('graphic')[0] != undefined){
      fig.href = x.getElementsByTagName('graphic')[0].getAttribute('xlink:href');
    } else {
      fig.href = undefined
    }
    figures.push(fig);
  });
  Array.prototype.forEach.call(doc.getElementsByTagName('supplementary-material'),function(x){
    var fig = {};
    if(x.getElementsByTagName('label')[0]!=undefined){
      fig.label = x.getElementsByTagName('label')[0].textContent;
    }
    if(fig.label){
      if(fig.label.match(/\d+$/)){
        fig.num = fig.label.match(/\d+$/)[0];
      }
    }
    if(x.getElementsByTagName('caption')[0] != undefined){
      fig.caption = x.getElementsByTagName('caption')[0].textContent.replace(/\n/g,'').trim();
    }
    fig.id = x.getAttribute('id');
    if(x.getElementsByTagName('media')[0] != undefined){
      fig.href = x.getElementsByTagName('media')[0].getAttribute('xlink:href');
    } else {
      fig.href = undefined
    }
    figures.push(fig);
  });
  return figures;
}

function _xml2jsonBody(xml){
  var doc = new DOMParser().parseFromString(xml,'text/xml');
  if(doc.getElementsByTagName('body').length){
    var body = doc.getElementsByTagName('body')[0];
  } else {
    var body = doc.getElementsByTagName('article')[0];
  }
  return _parseNode(body,xml);
}


function _parseNode(node,xml){
  var tmp = {
    tag: node.tagName,
    children: []
  };
  if(node.attributes != undefined){
    var tag = '';
    Object.keys(node.attributes).forEach(function(att){
      if(node.attributes[att].nodeValue==='image'){
        tag = 'img';
      }
      if(node.attributes[att].nodeValue==='bibr'){
        tag = 'bib-ref';
      }
      if(node.attributes[att].nodeValue==='fig'){
        tag = 'fig-ref';
      }
      if(node.attributes[att].nodeValue==='sec'){
        tag = 'sec-ref';
      }
      if(node.attributes[att].nodeValue==='table'){
        tag = 'table-ref';
      }
      if(node.attributes[att].nodeValue==='supplementary-material'){
        tag = 'suppl-ref';
      }
      if(node.attributes[att].localName==='rid'){
        if(node.attributes[att].value!=undefined){
          tmp.id = node.attributes[att].value; 
        }
      }
      if(node.attributes[att].nodeName==='id'){
        tmp.id = node.attributes[att].value;
      }
    });
    if(tag!=''){
      tmp.tag = tag;
    } 
    if(node.attributes.nodeName==='id'){
      tmp.id = node.attributes.value;      
    }
  }
  if(node.childNodes != null){
    if(node.childNodes.length>0){
      Array.prototype.forEach.call(node.childNodes,function(x){
        if(x.textContent!='\n'){
          if( x.tagName == 'table-wrap' ){
            var tab = {
              tag: 'table' 
            };
            Object.keys(x.attributes).forEach(function(att){
              if(x.attributes[att].localName==='id'){
                tab.id = x.attributes[att].value;
              }
            });
            var caption = [];
            Array.prototype.forEach.call(x.childNodes,function(y){
              if(y.tagName === 'label'){
                caption.push({
                  tag: 'text',
                  content: y.textContent
                });
              }
              if(y.tagName === 'caption'){
                Array.prototype.forEach.call(y.childNodes,function(z){
                  if( z.tagName == 'title'){
                    caption.push({
                      tag: 'text',
                      content: z.textContent
                    });
                  } else {
                    caption.push(_parseNode(z,xml));
                  }
                })
              }
            }); 


            var txt = _extractBetween(xml,'<table-wrap id="'+x.attributes['0'].value+'"','</table-wrap>');
            txt = txt.slice(txt.indexOf('>')+1,txt.length);
            txt = txt.slice(txt.indexOf('<table'),txt.length);
            txt = txt.slice(0,txt.lastIndexOf('</table>')+8);

            tab.table = txt;

            if(caption.length){
              tab.caption= caption;
            };

            tmp.children.push(tab);
          } else if ( x.tagName == 'fig' ){
            var fig = {
              tag: 'figure'
            };
            Object.keys(x.attributes).forEach(function(att){
              if(x.attributes[att].localName==='id'){
                fig.id = x.attributes[att].value;
              }
            });
            var caption = [];
            Array.prototype.forEach.call(x.childNodes,function(y){
              if(y.tagName === 'label'){
                caption.push({
                  tag: 'text',
                  content: y.textContent
                });
              }
              if(y.tagName === 'caption'){
                Array.prototype.forEach.call(y.childNodes,function(z){
                  if( z.tagName == 'title'){
                    caption.push({
                      tag: 'text',
                      content: z.textContent
                    });
                  } else {
                    caption.push(_parseNode(z,xml));
                  }
                })
              }
            });
            if(caption.length){
              fig.caption= caption;
            };
            tmp.children.push(fig);
          } else if ( x.tagName == 'disp-formula' ){
            var form = {
              tag: 'disp-formula'
            }
            Array.prototype.forEach.call(x.childNodes,function(y){
              if(y.tagName == 'label'){
                form.label = y.textContent;
              } else if(y.tagName == 'graphic') {
                Object.keys(y.attributes).forEach(function(att){
                  if(y.attributes[att].name==='xlink:href'){
                    form.id = y.attributes[att].value;
                  }
                });
              }
            })
            tmp.children.push(form);
          } else if ( x.tagName == 'supplementary-material' ){
            var sup = {
              tag: 'supplementary-material'
            };

            var caption = [];
            Array.prototype.forEach.call(x.childNodes,function(y){
              if(y.tagName === 'label'){
                caption.push({
                  tag: 'text',
                  content: y.textContent
                });
              }
              if(y.tagName === 'caption'){
                Array.prototype.forEach.call(y.childNodes,function(z){
                  if( z.tagName == 'title'){
                    caption.push({
                      tag: 'text',
                      content: z.textContent
                    });
                  } else {
                    caption.push(_parseNode(z,xml));
                  }
                })
              }
              if(y.tagName === 'media'){
                Object.keys(y.attributes).forEach(function(att){
                  if(y.attributes[att].name==='xlink:href'){
                    sup.id = y.attributes[att].value;
                  }
                });
              }
            });
            if(caption.length){
              sup.caption= caption;
            };
            tmp.children.push(sup);

          } else {
            tmp.children.push(_parseNode(x,xml));
          }
        }
      });
      return tmp;
    } else if(tmp.tag === 'img'){
      var img = {
        tag: 'inline-graphic'
      }
      Object.keys(node.attributes).forEach(function(att){
        if(node.attributes[att].name==='xlink:href'){
          img.id = node.attributes[att].value;
        }
      });
      return img;
    }  else {
      var txt = node.textContent.toString().replace(/(\r\n|\n|\r)/gm,"");
      return {
        tag: 'text',
        content: txt
      };
    }
  } else if(tmp.tag === 'img'){
    var img = {
      tag: 'inline-graphic'
    }
    Object.keys(node.attributes).forEach(function(att){
      if(y.attributes[att].name==='xlink:href'){
        img.id = y.attributes[att].value;
      }
    });
    return img;
  } else {
    var txt = node.textContent.toString().replace(/(\r\n|\n|\r)/gm,"");
    return {
      tag: 'text',
      content: txt
    };
  }
}


function _json2html(ldpm,jsonBody,pkg,artInd,abstract, callback){
  var html  = "<!doctype html>\n";
  html += "<html>\n";
  html += "\n<head>\n<title>\n" + pkg.article[artInd].headline + "\n</title>\n<meta charset='UTF-8'>\n";
  html += "</head>\n";
  html += "\n<body>\n";
  html += "<article>\n";
  html += "\n<h1>\n" + pkg.article[artInd].headline + "\n</h1>\n";
  if(pkg.keyword){
    html += '\n<section class="keywords">\n';
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
    html += '\n<section class="authors" >\n';
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
  html += '</section>\n\n';
  if(pkg.provider){
    html += '\n<section class="provider">\n';
    html += '<h3>Provider</h3>\n';
    html += pkg.provider.description + '\n';
    html += '</section>\n';
  }
  if(pkg.editor){
    html += '\n<section class="editors">\n';
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
    html += '\n<section class="journal">\n';
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

  if(abstract!=undefined){
    var id = uuid.v4();
    html += '\n<section id="' + id + '" typeof="http://salt.semanticauthoring.org/ontologies/sro#Abstract">\n'; //+ '" resource="' + pkg.name + '/' + id + '">\n';
    html += "<h2>Abstract</h2>";
    var doc = new DOMParser().parseFromString("<sec>" + abstract + "</sec>",'text/xml');
    var abs = doc.getElementsByTagName('sec')[0];
    _recConv(ldpm,_parseNode(abs,abstract),pkg,3, function(err,newTxt){
      if(err) return callback(err);
      html += newTxt;
      html += "</section>\n\n";
      _recConv(ldpm,jsonBody,pkg,2, function(err,newTxt){
        if(err) return callback(err);
        html += newTxt;
        html += "</article>\n";
        html += "</body>\n";
        html += "</html>";
        callback(null,html);
      });
    });
  } else {
    _recConv(ldpm,jsonBody,pkg,2, function(err,newTxt){
      if(newTxt != '<div>undefined</div>'){
        html += newTxt;
      } else {
        html += '<div>Empty article.</div>\n';
      }
      html += "</article>\n";
      html += "</body>\n";
      html += "</html>";
      callback(null,html);
    });
  }
}


function _recConv(ldpm,jsonNode,pkg,hlevel,callback){
  callback = once(callback);

  var knownTags = { 
    'disp-quote':'blockquote', 
    'sup': 'sup', 
    'sub': 'sub', 
    'bold': ['span class="bold"','span'], 
    'italic': ['span class="italic"','span'], 
    'underline': ['span class="underline"','span'],
    'inline-formula': 'span'
  };
  var txt = '';
  if( jsonNode.tag === 'body' ){
    var index = 0;
    async.eachSeries(jsonNode.children,
      function(x,cb){
        index+=1;
        _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
          txt += newTxt;
          cb();
        });
      },
      function(err){
        if(err) return callback(err);
        return callback(null,txt);
      }
    );    

  } else if( jsonNode.tag === 'sec' ){
    var id = uuid.v4();
    txt += '\n\n<section id="' + id + '"'; //+ '" resource="' + pkg.name + '/' + id + '">\n';
    var iri = _identifiedTitle(jsonNode); 
    if ( iri != ''){
      txt += ' typeof="' + iri + '" ';
    }
    txt += '>\n';
    var index = 100;
    async.eachSeries(jsonNode.children,
      function(x,cb){
        index += 1;
        _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
          txt += newTxt;
          return cb();
        });
      },
      function(err){
        if(err) return callback(err);
        txt += '</section>\n';
        return callback(null,txt);
      }
    ); 

  } else if( jsonNode.tag === 'p' ){  
    txt += '<p>\n';
    var index = 10000;
    async.eachSeries(jsonNode.children,
      function(x,cb){
        index += 1;
        _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
          if(err) return cb(err);
          txt += newTxt;
          return cb(null);
        });
      },
      function(err){
        if(err) return callback(err);
        txt += '\n';
        txt += '</p>\n';
        return callback(null,txt);
      }
    ); 

  } else if( jsonNode.tag === 'title' ){
    txt += ' <h' + hlevel + '>\n';
    async.eachSeries(jsonNode.children,
      function(x,cb){
        _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
          txt += newTxt;
          cb();
        });
      },
      function(err){
        if(err) return callback(err);
        txt += '\n </h' + hlevel + '>\n';
        return callback(null,txt);
      }
    );   

  } else if(Object.keys(knownTags).indexOf(jsonNode.tag)>-1){
    if(typeof knownTags[jsonNode.tag] === 'string'){
      txt += '\n<'+knownTags[jsonNode.tag]+'>\n';
    } else {
      txt += '\n<'+knownTags[jsonNode.tag][0]+'>\n';          
    }
    async.eachSeries(jsonNode.children,
      function(x,cb){
        _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
          txt += newTxt;
          cb();
        });
      },
      function(err){
        if(err) return callback(err);
        txt += '\n';
        if(typeof knownTags[jsonNode.tag] === 'string'){
          txt += '</'+knownTags[jsonNode.tag]+'>\n';
        } else {
          txt += '</'+knownTags[jsonNode.tag][1]+'>\n';          
        }
        return callback(null,txt);
      }
    );   

  } else if( jsonNode.tag === 'text' ){
    if(jsonNode.content.trim() != ''){
      if( (jsonNode.content.slice(0,1)==='.') || (jsonNode.content.slice(0,1)===')') ){ // TODO: regexp
        txt += jsonNode.content;
      } else {
        txt += ' '+jsonNode.content;
      }   
    }
    return callback(null,txt);

  } else if( jsonNode.tag === 'ext-link' ){
    txt += ' <a href="'+jsonNode.children[0].content+'">';
    txt += jsonNode.children[0].content;
    txt += '</a>';
    return callback(null,txt);

  } else if( jsonNode.tag === 'list' ){

    txt += ' <li>';
    async.eachSeries(jsonNode.children,
      function(ch,cb){
        if(ch.tag==='list-item'){
          txt += ' <item>\n';
          async.eachSeries(ch.children,
            function(ch2,cb2){
              _recConv(ldpm,ch2,pkg,hlevel,function(err,newTxt){
                txt += newTxt;
                cb2(null);
              });
            },
            function(err){
              txt += ' </item>\n';
              cb(null);
            }
          )
        }
      },
      function(err){
        if(err) return callback(err);
        txt += jsonNode.children[0].content;
        txt += '</li>\n';
        return callback(null,txt);
      }
    ); 

  } else if( jsonNode.tag === 'bib-ref' ){
    found = false;

    txt += '<span property="http://schema.org/citation">'
    pkg.article.forEach(function(art){
      if(art.citation){
        art.citation.forEach(function(cit){
          if(cit.name == jsonNode.id){
            found = true;
            if(cit.url){
              txt += ' <a href="'+cit.url+'">';

              async.eachSeries(jsonNode.children,
                function(x,cb){
                  _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
                    txt += newTxt;
                    cb();
                  });
                },
                function(err){
                  if(err) return callback(err);
                  txt += '</a>';
                  txt += '</span>';
                  return callback(null,txt);
                }
              ); 
            } else {
              var ind = parseInt(jsonNode.children[0]['content'].slice(1,jsonNode.children[0]['content'].length-1),10);
              txt += ' <a href="#ref_' + ind + '">';
              async.eachSeries(jsonNode.children,
                function(x,cb){
                  _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
                    txt += newTxt;
                    cb();
                  });
                },
                function(err){
                  if(err) return callback(err);
                  txt += '</a>';
                  txt += '</span>';
                  return callback(null,txt);
                }
              ); 
            }
          }
        })
      }  
    })



    if(!found){
      async.eachSeries(jsonNode.children,
        function(x,cb){
          _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
            txt += newTxt;
            cb();
          });
        },
        function(err){
          if(err) return callback(err);
          return callback(null,txt);
        }
      ); 
    }

  } else if( jsonNode.tag === 'sec-ref' ){
    async.eachSeries(jsonNode.children,
      function(x,cb){
        _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
          txt += newTxt;
          cb();
        });
      },
      function(err){
        if(err) return callback(err);
        return callback(null,txt);
      }
    ); 
  } else if( (jsonNode.tag === 'suppl-ref') || (jsonNode.tag === 'fig-ref') || (jsonNode.tag === 'table-ref') ){
    found = false;
    var typeMap = { 'figure': 'figure', 'audio': 'audio', 'video': 'video', 'code': 'TargetProduct', 'dataset': 'distribution', 'article': 'encoding'};
    Object.keys(typeMap).forEach(
      function(type){
        if(pkg[type]){
          pkg[type].forEach(function(r,cb){
            if(jsonNode.id != undefined){
              if( (r.name == jsonNode.id.replace(/\./g,'-')) || (r.alternateName == jsonNode.id.replace(/\./g,'-')) ){

                found = true;

                if(r[typeMap[type]][0].contentUrl){

                  txt += '<a href="'+r[typeMap[type]][0].contentUrl+'">';
                  async.eachSeries(jsonNode.children,
                    function(x,cb){
                      _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
                        txt += newTxt;
                        return cb(null);
                      });
                    },
                    function(err){
                      if(err) return callback(err);
                      txt += '</a>';
                      return callback(null,txt);
                    }
                  ); 

                } else {
                  var sha1 = crypto.createHash('sha1');
                  var size = 0
                  var p = path.resolve(ldpm.root, r[typeMap[type]][0].contentPath);
                  var s = fs.createReadStream(p).pipe(zlib.createGzip());
                  s.on('error',  function(err){cb(err)});
                  s.on('data', function(d) { size += d.length; sha1.update(d); });
                  s.on('end', function() { 
                    var sha = sha1.digest('hex');
                    txt += '<a href="' + BASE + '/r/'+sha+'">';
                    
                    async.eachSeries(jsonNode.children,
                      function(x,cb){
                        _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
                          txt += newTxt;
                          return cb();
                        });
                      },
                      function(err){
                        if(err) return callback(err);
                        txt += '</a>';
                        return callback(null,txt);
                      }
                    );
                  });  
                }
              }
            } 
          })
          if(!found){
            jsonNode.children.forEach(function(x){
              _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
                txt += newTxt;
                return callback(null,txt);
              });
            });
          }
        }
      }
    );

  } else if( jsonNode.tag === 'figure' ){
    var id = uuid.v4();
    txt += '\n\n<figure ';
    txt += 'id="' + id + '" resource="' + pkg.name + '/' + id + '"';
    txt += '>\n'; 
    pkg.figure.forEach(function(fig){
      if( (fig.name == jsonNode.id.replace(/\./g,'-')) || (fig.alternateName == jsonNode.id.replace(/\./g,'-')) ){
        var found = false;
        fig.figure.forEach(function(enc){
          if( (!found) && ( (enc.encodingFormat==='image/jpeg') || (enc.encodingFormat==='image/png') ) ){
            found = true;
            if(enc.contentUrl){
              txt += '<img src="' + enc.contentUrl +'">';
              if(jsonNode.caption){
                txt += '<figcaption typeof="http://purl.org/spar/deo/Caption">\n'; 
                async.eachSeries(jsonNode.caption,
                  function(x,cb){
                    _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
                      txt += newTxt;
                      cb();
                    });
                  },
                  function(err){
                    if(err) return callback(err);
                    txt += '</figcaption>\n'; 
                    txt += '</figure>\n'; 
                    return callback(null,txt);
                  }
                ); 
              } else {
                txt += '</figure>\n'; 
                return callback(null,txt);
              }    
            } else {
              var sha1 = crypto.createHash('sha1');
              var size = 0
              var p = path.resolve(ldpm.root, enc.contentPath);
              var s = fs.createReadStream(p).pipe(zlib.createGzip());
              s.on('error',  function(err){cb(err)});
              s.on('data', function(d) { size += d.length; sha1.update(d); });
              s.on('end', function() { 
                var sha = sha1.digest('hex');
                txt += '<img src="' + BASE + '/r/'+sha+'">';
                if(jsonNode.caption){
                  txt += '<figcaption typeof="http://purl.org/spar/deo/Caption">\n'; 
                  async.eachSeries(jsonNode.caption,
                    function(x,cb){
                      _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
                        txt += newTxt;
                        cb();
                      });
                    },
                    function(err){
                      if(err) return callback(err);
                      txt += '</figcaption>\n'; 
                      txt += '</figure>\n'; 
                      return callback(null,txt);
                    }
                  ); 
                } else {
                  txt += '</figure>\n'; 
                  return callback(null,txt);
                }         
              });
            }
          }
        })
      }
    })

  } else if( jsonNode.tag === 'table' ){

    txt += '<table>\n'; 
    txt += jsonNode.table;
    if(jsonNode.caption){
      txt += '<caption typeof="http://purl.org/spar/deo/Caption">\n'; 
      async.eachSeries(jsonNode.caption,
        function(x,cb){
          _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
            txt += newTxt;
            cb();
          });
        },
        function(err){
          if(err) return callback(err);
          txt += '\n</caption>\n'; 
          txt += '</table>\n'; 
          return callback(null,txt);
        }
      ); 
    } else {
      txt += '</table>\n'; 
      return callback(null,txt);
    }

  } else if( jsonNode.tag === 'supplementary-material' ){

    txt += '<div>';
    found = false;

    var typeMap = { 'figure': 'figure', 'audio': 'audio', 'video': 'video', 'code': 'TargetProduct', 'dataset': 'distribution', 'article': 'encoding'};
    Object.keys(typeMap).forEach(
      function(type){
        if(pkg[type]){
          pkg[type].forEach(
            function(r,i){
              if(r.name == path.basename(jsonNode.id,path.extname(jsonNode.id)).replace(/\./g,'-')){
                found = true;
                if(r[typeMap[type]][0].contentUrl){
                  txt += '<a href="'+r[typeMap[type]][0].contentUrl+'">';
                  txt += 'Click here to obtain the resource.';
                  txt += '</a>';
                } else {
                  txt += jsonNode.id;  
                }
              }
            }
          )
        }
      }
    );


    if(!found){
      txt += jsonNode.id; 
    }

    if(jsonNode.caption){
      txt += '<caption>'; 
      async.eachSeries(jsonNode.caption,
        function(x,cb){
          _recConv(ldpm,x,pkg,hlevel,function(err,newTxt){
            txt += newTxt;
            cb();
          });
        },
        function(err){
          if(err) return callback(err);
          txt += '</caption>'; 
          txt += '</div>'; 
          return callback(null,txt);
        }
      );

    } else {
      txt += '</div>'; 
      return callback(null,txt);
    }

  } else if( jsonNode.tag === 'inline-graphic' ){

    found = false;
    var typeMap = { 'figure': 'figure' };
    Object.keys(typeMap).forEach(
      function(type){
        if(pkg[type]){
          pkg[type].forEach(function(r,cb){
            if(jsonNode.id != undefined){
              if(r.name == path.basename(jsonNode.id,path.extname(jsonNode.id)).replace(/\./g,'-')){
                found = true;

                var indjpg;
                r[typeMap[type]].forEach(function(enc,i){
                  if(enc.encodingFormat === 'image/jpeg'){
                    indjpg = i;
                  }
                })

                gm(r[typeMap[type]][indjpg].contentPath)
                 .toBuffer(function (err, buffer) {
                   if (err) return callback(err);
                   var dataUrl =  "data:" + 'image/jpg' + ";base64,"  + buffer.toString('base64');
                    txt += '<img src="' + dataUrl +'">';
                   return callback(null,txt);
                });

              }
            } 
          })
        }
      }
    );

  } else if ( jsonNode.tag === 'disp-formula'){

    txt += '\n<div class="formula" ';
    if(jsonNode.label){
      txt += 'id="' + jsonNode.label + '"';
    } 
    txt += '>\n';

    found = false;
    var typeMap = { 'figure': 'figure' };
    Object.keys(typeMap).forEach(
      function(type){
        if(pkg[type]){
          pkg[type].forEach(function(r,cb){
            if(jsonNode.id != undefined){
              if(r.name == path.basename(jsonNode.id,path.extname(jsonNode.id)).replace(/\./g,'-')){
                found = true;

                var indjpg;
                r[typeMap[type]].forEach(function(enc,i){
                  if(enc.encodingFormat === 'image/jpeg'){
                    indjpg = i;
                  }
                })


                gm(r[typeMap[type]][indjpg].contentPath)
                 .toBuffer(function (err, buffer) {
                   if (err) return callback(err);
                   var dataUrl =  "data:" + 'image/jpg' + ";base64,"  + buffer.toString('base64');
                    txt += '<img src="' + dataUrl +'">';
                    if(jsonNode.label){
                      txt += '\n<span class="eq-label">\n';
                      txt += jsonNode.label;
                      txt += '\n</span>\n';
                    }
                  txt += '</div>\n';
                   return callback(null,txt);
                });
            
              }
            } 
          })
        }
      }
    ); 



  } else {
    return callback(null,txt);
  }
}

function _identifiedTitle(node){
  var iris = {
    'introduction': 'http://purl.org/spar/deo/Introduction',
    'acknowledgements': 'http://purl.org/spar/deo/Acknowledgements',
    'discussion': 'http://salt.semanticauthoring.org/ontologies/sro#Discussion',
    'materials': 'http://purl.org/spar/deo/Materials',
    'methods': 'http://purl.org/spar/deo/Methods',
    'results': 'http://purl.org/spar/deo/Results'
  }
  var iri = ''
  node.children.forEach(function(ch){
    if(ch.tag==='title'){
      ch.children.forEach(function(x){
        if(x.tag==='text'){
          if( Object.keys(iris).indexOf(x.content.toLowerCase())>-1){
            iri = iris[x.content.toLowerCase()];
          }
        }
      })
    }
  })
  return iri;
}

function _addRefsHtml(htmlBody,article){
  var indbeg = htmlBody.indexOf('</article>');
  htmlBody = htmlBody.slice(0,indbeg);
  if(article.citation){
    htmlBody += '\n<section typeof="http://purl.org/spar/deo/BibliographicReference">\n';
    htmlBody += '<h2>Bibliography</h2>\n';
    htmlBody += '<ol>\n';
    article.citation.forEach(function(cit,i){
      htmlBody += '<li id="ref_' + parseInt(i+1,10) + '">\n';
      htmlBody += cit.description;
      htmlBody += '<br>\n';
      if(cit.doi){
        htmlBody += 'doi:' + cit.doi + '\n';
      }
      if(cit.pmid){
        htmlBody += 'pmid:' + cit.pmid + '\n';
      }
      if(cit.url){
        htmlBody += '<a href="' + cit.url +'">link</a>' + '\n';
      }
      htmlBody += '</li>\n';
    });
    htmlBody += '</ol>\n';
    htmlBody += '</section>\n';
  }
  htmlBody += '\n</article>\n';
  htmlBody += '</body>\n';
  htmlBody += '</html>';
  return htmlBody;
}

function _addMetadata(pkg,mainArticleName,uri,ldpm,opts,callback){
  var pmcid = _extractBetween(uri,'PMC');
  var parser = new xml2js.Parser();
  var meta = {};
  var relPaths;

  if(arguments.length === 5){
    callback = opts;
    opts = {};
  }

  callback = once(callback);

  console.log(uri)

  request(uri,
    function(error,response,body){
      if(error) return callback(error);

      var jsonBody = _xml2jsonBody(body);

      var xmlBody = body;

      var figures = _findFigures(xmlBody);

      parser.parseString(body,function(err,body){
        if(err) return callback(error);

        var pathArt = _findNodePaths(body,['article','datestamp']);

        if(pathArt['datestamp']){
          meta.dateCreated = traverse(body).get(pathArt['datestamp'])[0];
        }

        //scrap
        if(pathArt['article']){
          if(pkg.article==undefined){
            pkg.article = [{}];
          }
          var data = traverse(body).get(pathArt['article'])[0];
          pkg.article[0]['@type'] = 'ScholarlyArticle';
          if(data['$']['article-type'] != undefined){
            pkg.article[0].publicationType = data['$']['article-type'].replace(/-/g,' ');
          }
        }

        var absPaths = _findNodePaths(data,['journal-meta','article-meta']);

        var $journalMeta = traverse(data).get(absPaths['journal-meta']);
        relPaths = _findNodePaths($journalMeta,['publisher-name','publisher-loc','journal-title','journal-id','issn']);

        if(relPaths['publisher-name']){
          meta.publisher = {
            name: traverse($journalMeta).get(relPaths['publisher-name'])[0]
          };
        }
        if(relPaths['publisher-loc'] != undefined){
          meta.publisher.location = {
            description: traverse($journalMeta).get(relPaths['publisher-loc'])[0]
          }
        }
        if(relPaths['journal-title']){
          meta.journal = {
            name: traverse($journalMeta).get(relPaths['journal-title'])[0]
          }
        }

        if(relPaths['journal-id']){
          traverse($journalMeta).get(relPaths['journal-id']).forEach(function(x,i){
            if(x['$']['journal-id-type']=='nlm-ta'){
              meta.journalShortName = '';
              x['_'].split(' ').forEach(function(x,i){
                if(i>0){
                  meta.journalShortName += '-'
                }
                meta.journalShortName += x.replace(/\W/g, '').toLowerCase();
              })
              // meta.journalShortName = x['_'].replace(/\W/g, '').replace(/ /g,'-').toLowerCase();
            }
          });
        }
        if(meta.journalShortName==undefined){
          meta.journalShortName = '';
          meta.journal.name.split(' ').forEach(function(x,i){
            if(i>0){
              meta.journalShortName += '-'
            }
            meta.journalShortName += x.replace(/\W/g, '').toLowerCase();
          })
          // meta.journalShortName = meta.journal.name.replace(/\W/g, '').replace(/ /g,'-').toLowerCase();
        }

        if(relPaths['issn']){
          meta.journal.issn = traverse($journalMeta).get(relPaths['issn'])[0]['_'];
        }


        var $articleMeta = traverse(data).get(absPaths['article-meta']);
        relPaths = _findNodePaths($articleMeta,
          [
            'article-id',
            'subj-group',
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
            'license',
            'year',
            'month',
            'day',
            'doi',
            'email'
          ]
        );

        if(relPaths['article-id']){
          traverse($articleMeta).get(relPaths['article-id']).forEach(function(x,i){
            if(x['$']['pub-id-type']=='doi'){
              meta.doi = x['_'];
            } else if (x['$']['pub-id-type']=='pmid'){
              meta.pmid = x['_'];
            }
          });
        }

        if(relPaths['subj-group']){
          var keyword = [];
          traverse($articleMeta).get(relPaths['subj-group']).forEach(function(x){
            keyword = keyword.concat(_extractKeywords(x));
          })
          meta.keyword = keyword;
        }

        if(relPaths['article-title']){
          if(typeof traverse($articleMeta).get(relPaths['article-title'])[0] === 'string'){
            meta.title = traverse($articleMeta).get(relPaths['article-title'])[0];
          } else {
            var doc = new DOMParser().parseFromString(
                '<xml xmlns="a" xmlns:c="./lite">'+
                _extractBetween(xmlBody,'<article-title>','</article-title>') +
                '</xml>'
                ,'text/xml');
            meta.title = doc.lastChild.textContent;
          }
        }

        if(relPaths['alt-title']){
          meta.shortTitle = traverse($articleMeta).get(relPaths['alt-title'])[0]['_'];
        }

        var affiliations = {};
        if(relPaths['aff']){
          traverse($articleMeta).get(relPaths['aff']).forEach(
            function(x){
              var key;
              if(x['$']){
                key = x['$']['id'];
              } else {
                key = 'unknown';
              }
              affiliations[key] =  [];
              var affiliation = {};
              var tmp = '';
              if(x['institution']){
                affiliation.name = x['institution'][0];
                tmp = x['institution'][0] + '. ';
              }
              if(x['addr-line']){
                tmp += x['addr-line'][0] + '. ';
              }
              if(x['country']){
                if(affiliation.address == undefined){
                  affiliation.address = {};
                }
                affiliation.address.addressCountry = x['country'][0];
                tmp += x['country'][0] + '. ';
              }
              if(tmp!=''){
                affiliation.description = tmp;
                affiliations[key].push(affiliation);
              } else {
                if( (typeof x === 'Object') && (x['sup']!=undefined) ){
                  var aff = _extractBetween(xmlBody,'<aff id="'+x['$']['id']+'">','</aff>');
                  aff.split('</sup>').forEach(function(y,i){
                    if(i>0){
                      var des = y;
                      if(des.indexOf('<sup>')>-1){
                        des = des.slice(0,des.indexOf('<sup>')).trim();
                      }
                      if(des[des.length-1]===','){
                        des = des.slice(0,des.length-1).trim();
                      }
                      if(des.slice(des.length-3,des.length)==='and'){
                        des = des.slice(0,des.length-3).trim();
                      }
                      affiliations[key].push({
                        sup: i,
                        description: des
                      });
                    }
                  })
                } else if (typeof x === 'object'){
                  affiliations[key].push({ description: x['_'] });
                } else {
                  affiliations[key].push({ description: x});
                }
              }
            }
          );
        }

        var emails = {};
        if(relPaths['author-notes']){
          var found = false;
          traverse($articleMeta).get(relPaths['author-notes']).forEach(
            function(x){
              if(x['corresp']){
                if (x['corresp'][0]['$']){
                  if(x['corresp'][0]['email']){
                    if(x['corresp'][0]['email'][0]['$']){
                      emails[x['corresp'][0]['$']['id']] = x['corresp'][0]['email'][0]['_'];

                    } else {
                      emails[x['corresp'][0]['$']['id']] = x['corresp'][0]['email'][0];
                    }
                    found = true;
                  }
                }
              }
            }
          );
        }

        if(relPaths['email']){
          emails.unkwon = relPaths['email'][0];
        }

        var author;
        var contributor = [];
        var accountablePerson = [];
        var sourceOrganisation = [];
        var sourceNames = [];
        var editor = [];
        if(relPaths['contrib-group']){
          traverse($articleMeta).get(relPaths['contrib-group']).forEach(
            function(x){
              if(x['contrib'][0]['$']['contrib-type']=='author'){
                x['contrib'].forEach(function(y,i){
                  var corresp = false;
                  if(y['name']){
                    if(y['name'][0]['given-names']){
                      if(y['name'][0]['given-names'][0]!=undefined){
                        var givenName = y['name'][0]['given-names'][0];
                      }
                    }
                    if(y['name'][0]['surname']){
                      if(y['name'][0]['surname'][0]!=undefined){
                        var familyName = y['name'][0]['surname'][0];
                      }
                    }
                    var affiliation = [];
                    var email = '';
                    if(y.xref){
                      y.xref.forEach(function(z){
                        if(z['$']['ref-type']){
                          if (z['$']['ref-type'] == 'aff'){
                            if(affiliations.unknown != undefined){
                              affiliation.push(  affiliations.unknown[0] );
                            } else {
                              if(affiliations[z['$']['rid']]!=undefined){
                                if(z['sup']!=undefined){
                                  affiliations[z['$']['rid']].forEach(function(w){
                                    if(w.sup == undefined){
                                      affiliation.push(w);
                                    } else {
                                      if(w.sup==z['sup'][0]){
                                        affiliation.push({ description : w.description });
                                      }  
                                    }
                                  })
                                } else {
                                  affiliation.push( affiliations[z['$']['rid']][0] );
                                }
                              }
                            }
                          } else if (z['$']['ref-type'] == 'corresp'){
                            if(emails[z['$']['rid']]){
                              email = emails[z['$']['rid']];
                            } else {
                              email = emails['unknown'];
                            }
                            corresp = true;
                          }
                        } else {
                          if(affiliations.unknown !=  undefined){
                            affiliation.push(  affiliations.unknown[0] );
                          }
                        }
                      });
                    } else {
                      if(affiliations.unknown !=  undefined){
                        affiliation.push(  affiliations.unknown[0] );
                      }
                    }
                    if(affiliation.length == 0){
                      if(affiliations.unknown !=  undefined){
                        affiliation.push(  affiliations.unknown[0] );
                      }
                    }

                    if(y['email']){
                      email = y['email'][0]
                      if(y['$']['corresp']=='yes'){
                        corresp = true;
                      }
                    }

                    affiliation.forEach(function(y){
                      if(sourceNames.indexOf(y.description)==-1){
                        sourceOrganisation.push(y);
                        sourceNames.push(y.description);
                      }
                    });

                    if(i==0){
                      author = {}
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
                      if (email != ''){
                        author.email = email
                      }
                      if(affiliation.length){
                        if(affiliation[0]!={}){
                          author.affiliation = affiliation;
                        }
                      }
                    } else {
                      var tmpcontr = {};
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
                      if(email!=''){
                        tmpcontr.email = email;
                      }
                      contributor.push(tmpcontr);
                    }
                    if (corresp){
                      var tmpacc = {};
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
                      if(email!=''){
                        tmpacc.email = email;
                      }
                      accountablePerson.push(tmpacc);
                    }
                  }

                  
                });
              } else if (x['contrib'][0]['$']['contrib-type']=='editor'){
                x['contrib'].forEach(function(y,i){
                  if(y['name']){
                    if(y['name'][0]['given-names']){
                      var givenName = y['name'][0]['given-names'][0];
                    }
                    if(y['name'][0]['surname']){
                      var familyName = y['name'][0]['surname'][0];
                    }
                    var tmped = {};
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
                });
              }
            }
          );
        }

        meta.author = author;
        meta.contributor = contributor;
        meta.editor = editor;
        meta.accountablePerson = accountablePerson;
        meta.sourceOrganisation = sourceOrganisation;

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
          if(xmlBody.indexOf('<abstract>')>-1){
            var doc = new DOMParser().parseFromString(
                '<xml xmlns="a" xmlns:c="./lite">'+
                _extractBetween(xmlBody,'<abstract>','</abstract>') +
                '</xml>'
                ,'text/xml');
            meta.abstractHtml = _extractBetween(xmlBody,'<abstract>','</abstract>');
            meta.abstract = doc.lastChild.textContent.trim();
          }
        }

        if(relPaths['page-count']){
          meta.numPages = traverse($articleMeta).get(relPaths['page-count'])[0]['$']['count'];
        }

        references = [];

        if(data.back){

          if(data.back[0]['ref-list']){

            if(data.back[0]['ref-list'][0]['ref'] != undefined){
              var reflist = data.back[0]['ref-list'][0]['ref'];
            } else {
              var reflist = data.back[0]['ref-list'][0]['ref-list'][0]['ref'];
            }

            reflist.forEach(function(x){

              Object.keys(x).forEach(function(k){
                if(k.indexOf('citation')>-1){
                  y = x[k][0];
                }
              })


              // if (y['$']['publication-type'] == 'journal'){

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
                x['$']['id']

                ref.header = '';
                if(typeof y['article-title'] === 'string'){
                  ref.header = y['article-title'];
                } else {
                  var id = x['$']['id'];
                  var tmp = _extractBetween(xmlBody,'<ref id="'+id+'">','</ref>');
                  if(tmp.indexOf('<article-title>')>-1){
                    tmp = _extractBetween(tmp,'<article-title>','</article-title>');
                    var doc = new DOMParser().parseFromString(
                        '<xml xmlns="a" xmlns:c="./lite">'+
                        tmp+
                        '</xml>'
                        ,'text/xml');
                    ref.header = doc.lastChild.textContent;
                  } else if(y['source']){
                      ref.header = y['source'];
                  }
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
                if(ref.doi == undefined){
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

                if(ref.doi != undefined){
                  ref.url = 'http://doi.org/'+ref.doi;
                  if(ref.pmid){
                    ref.sameAs = 'http://www.ncbi.nlm.nih.gov/pubmed/?term=' + ref.pmid;
                  }
                } else {
                  if(ref.pmid){
                    ref.url = 'http://www.ncbi.nlm.nih.gov/pubmed/?term=' + ref.pmid;
                  }
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
                ref.description = descr;

                if(ref.header){
                  references.push(ref);
                }
              // }
            });
          }
        }

        if(references.length){
          meta.references = references;
        }

        // Fill pkg, controlling the order
        var newpkg = {};
        newpkg.name = '';
        if(meta.journalShortName){
          newpkg.name += meta.journalShortName;
        }
        if(meta.author){
          if(meta.author.familyName){
            newpkg.name += '-' + removeDiacritics(meta.author.familyName.toLowerCase()).replace(/\W/g, '');
          } else {
            callback(new Error('did not find the author family name'));
          }
        } else {
          newpkg.name += '-' + removeDiacritics(meta.title.split(' ')[0].toLowerCase()).replace(/\W/g, '');
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

        if(meta.keyword){
          newpkg.keyword = meta.keyword;
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

        author['@type'] = 'Person';
        newpkg.author =  meta.author;


        if(meta.contributor.length){
          newpkg.contributor =  meta.contributor;
          newpkg.contributor.forEach(function(y){
            y['@type'] = 'Person';
          })
        }


        newpkg.sourceOrganisation = [ {
          '@type': 'Organization',
          '@id': 'http://www.nlm.nih.gov/',
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
              y['@type'] = 'Organization';
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
            newpkg.editor.forEach(function(y){
              y['@type'] = 'Person';
            });
            if(newpkg.editor.affiliation){
              newpkg.editor.affiliation['@type'] = 'Organization';
            }
          }
        }

        if(meta.publisher){
          newpkg.publisher = meta.publisher;
          newpkg.publisher['@type'] = 'Organization';
          if(newpkg.publisher.location){
            newpkg.publisher.location['@type'] = 'PostalAddress';
          }
        }

        if(meta.journal){
          newpkg.journal = meta.journal;
          newpkg.journal['@type'] = 'bibo:Journal';
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
          newpkg.copyrightHolder['@type'] = 'Organization';
        }

        var typeMap = {
          'dataset': 'Dataset',
          'code': 'Code',
          'figure': 'ImageObject',
          'audio': 'AudioObject',
          'video': 'VideoObject'
        };

        ['dataset','code','figure','audio','video','article'].forEach(function(type){
          if (pkg[type] != undefined){
            pkg[type].forEach(function(x,i){
              if(x.name==undefined){
                x.name = type+'-'+i;
              }
              x.name = x.name.replace(/\./g,'-');
              
              if(typeMap[type]){
                x['@type'] = typeMap[type];
              }

              if(meta.publicationDate){
                x.datePublished = meta.publicationDate;
              }

              pkg[type][i] = x;


              figures.forEach(function(fig){
                var v = [fig.id, fig.href];
                if(fig.id){
                  v.push(fig.id.replace(/\./g,'-'));
                }
                if(fig.href){
                  v.push(fig.href.replace(/\./g,'-'));
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

        if (mainArticleName != undefined){
          pkg.article.forEach(function(x,i){
            if(x.name==mainArticleName.slice(0,path.basename(mainArticleName,'.pdf').lastIndexOf('.')).replace(/\./g,'-')){
              var article = x;
              if(meta.journal){
                article.journal = meta.journal;
              }
              if(meta.doi){
                article.doi = meta.doi;
              }
              if(meta.pmid){
                article.pmid = meta.pmid;
              }
              if(meta.title){
                article.headline = meta.title;
              }
              if (meta.abstract){
                article.abstract = meta.abstract;
              }
              if(meta.references){
                article.citation = meta.references;
              }
              if(meta.issue){
                article.issue = meta.issue;
              }
              if(meta.volume){
                article.volume = meta.volume;
              }
              if(meta.pageStart){
                article.pageStart = meta.pageStart;
              }
              if(meta.pageEnd){
                article.pageEnd = meta.pageEnd;
              }
              pkg.article[i] = article;
            }

          });
          
        } else {
          // in case there is no pdf
          var article = {};
          if(meta.journal){
            article.journal = meta.journal;
          }
          if(meta.doi){
            article.doi = meta.doi;
          }
          if(meta.pmid){
            article.pmid = meta.pmid;
          }
          if(meta.title){
            article.headline = meta.title;
          }
          if (meta.abstract){
            article.abstract = meta.abstract;
          }
          if(meta.reference.length){
            article.citation = meta.references;
          }
          if(meta.issue){
            article.issue = meta.issue;
          }
          if(meta.volume){
            article.volume = meta.volume;
          }
          if(meta.pageStart){
            article.pageStart = meta.pageStart;
          }
          if(meta.pageEnd){
            article.pageEnd = meta.pageEnd;
          }
          pkg.article.push(article);
        }        
        newpkg.article = pkg.article;


        var found = false;
        var nxmlName = '';
        var artInd = 0;
        newpkg.article.forEach(function(art,i){
          art.encoding.forEach(function(enc){
            if(enc.encodingFormat === 'application/octet-stream'){
              if(enc.contentPath){
                nxmlName = path.basename(enc.contentPath,path.extname(enc.contentPath));
              } else if(enc.contentUrl){
                nxmlName = path.basename(enc.contentUrl,path.extname(enc.contentUrl));
              }
              found = true;
              artInd = i;
            }
          });
        });

        ['dataset','code','figure','audio','video','article'].forEach(function(type){
          if(newpkg[type]){
            if(newpkg[type].length===0){
              delete newpkg[type];
            }            
          }
        });

        _json2html(ldpm,jsonBody,newpkg,artInd,meta.abstractHtml, function(err, htmlBody){
          htmlBody = _addRefsHtml(htmlBody,newpkg.article[artInd]);
          fs.writeFile(path.join(ldpm.root,nxmlName+'.html'),htmlBody,function(err){
            if(err) return callback(err);
            ldpm.paths2resources([path.join(ldpm.root,nxmlName+'.html')],{}, function(err,resources){
              if(err) return callback(err);
              var found = false;
              newpkg.article[artInd].encoding.forEach(function(enc){
                if(enc.encodingFormat == "text/html"){
                  found = true;
                }
              })
              if(!found){
                newpkg.article[artInd].encoding.push(resources.article[0].encoding[0]);                
              }
              pushed = true;

              if ( (!opts.noPubmed) && (meta.pmid!=undefined) ){
                // call pubmed to check if there isn't additional info there
                uri = 'http://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id='+meta.pmid+'&rettype=abstract&retmode=xml';
                pubmed.call(ldpm, uri, { writeHTML: false }, function(err,pubmed_pkg){
                  if(pubmed_pkg){
                    var hasBody = {
                      "@type": ["Tag", "Mesh"],
                      "@context": BASE + "/mesh.jsonld"
                    };
                    var graph = [];

                    if(pubmed_pkg.annotation){

                      if(newpkg.annotation == undefined){
                        newpkg.annotation = [];
                      }

                      var found = false;
                      var pmfile = pubmed_pkg.article[0].encoding[0].contentPath;
                      newpkg.article[artInd].encoding.forEach(function(enc){
                        if(enc.contentPath === pmfile){
                          found = true;
                        }
                      })

                      // if(!found){
                      //   fs.unlinkSync(pmfile);
                      // }

                      pubmed_pkg.annotation[0].hasTarget = [
                        {
                          "@type": "SpecificResource",
                          hasSource: "r/f9b634be34cb3f2af4fbf4395e3f24b3834da926",
                          hasScope: newpkg.name + '/' + newpkg.version + '/article/' + newpkg.article[artInd].name,
                          hasState: {
                            "@type": "HttpRequestState",
                            value: "Accept: text/html"
                          }
                        }
                      ]
                      newpkg.annotation = newpkg.annotation.concat(pubmed_pkg.annotation)

                    }
                  }
                  callback(null,newpkg);
                });
              } else {
                callback(null,newpkg);
              }


            });
          });
        });
        

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
