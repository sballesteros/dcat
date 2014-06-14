var request = require('request')
  , fs = require('fs')
  , url = require('url')
  , http = require('http')
  , exec = require('child_process').exec
  , spawn = require('child_process').spawn
  , async = require('async')
  , path = require('path')
  , temp = require('temp')
  , _ = require('underscore')
  , emitter = require('events').EventEmitter
  , events = require('events')
  , tar = require('tar')
  , Client = require('ftp')
  , DecompressZip = require('decompress-zip')
  , zlib = require('zlib')
  , traverse = require('traverse')
  , recursiveReaddir = require('recursive-readdir')
  , Ldpm = require('../index')
  , DOMParser = require('xmldom').DOMParser;

module.exports = annotator;


/**
 * 'this' is an Ldpm instance
 */

function annotator(pkg, opts, callback){

  if(arguments.length === 2){
    callback = opts;
    opts = {};
  }

  var text_to_annotate = "The NCCN Guidelines for Melanoma provide multidisciplinary recommendations for the management of patients with melanoma. These NCCN Guidelines Insights highlight notable recent updates. Dabrafenib and trametinib, either as monotherapy (category 1) or combination therapy, have been added as systemic options for patients with unresectable metastatic melanoma harboring BRAF V600 mutations. Controversy continues regarding the value of adjuvant radiation for patients at high risk of nodal relapse. This is reflected in the category 2B designation to consider adjuvant radiation following lymphadenectomy for stage III melanoma with clinically positive nodes or recurrent disease.";


  var uri = 'http://data.bioontology.org/annotator?text=' + text_to_annotate + '&apikey=e71ce8d0-6b8f-4b0b-933d-0ff5a3d4efa1'

  request(uri, function (error, response, body) {
    console.log(JSON.parse(body).length);
    callback(null,JSON.parse(body));
    // console.log(JSON.stringify(body,null,4));
  });

}
