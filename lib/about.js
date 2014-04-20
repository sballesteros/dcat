var binaryCSV = require('binary-csv')
  , zlib = require('zlib')
  , util = require('util')
  , jsonLdContextInfer = require('jsonld-context-infer')
  , stream = require('stream')
  , xlsx = require('xlsx')
  , xls = require('xlsjs')
  , once = require('once')
  , split = require('split')
  , concat = require('concat-stream');

function about(readable, headers, nSample, callback){

  var encoding = headers['content-encoding'] || 'identity';
  var decompress, dataStream;

  if (encoding.match(/\bdeflate\b/)) {
    decompress = zlib.createInflate();
  } else if (encoding.match(/\bgzip\b/)) {
    decompress = zlib.createGunzip();
  }

  if (decompress) {
    dataStream = readable.pipe(decompress);
  } else {
    dataStream = readable;
  }

  if(headers['content-type'] === 'application/vnd.ms-excel' || headers['content-type'] === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'){
    aboutXls(dataStream, headers, nSample, callback);
  } else if (headers['content-type'] === 'text/csv' || header['content-type'] === 'text/tab-separated-values'){
    aboutCsvTsv(dataStream, headers, nSample, callback);
  } else if (headers['content-type'] === 'application/x-ldjson'){
    aboutLdJson(dataStream, headers, nSample, callback);
  } else {
    callback(new Error('cannot generate about for Content-Type: ' + headers['content-type']));
  }

};


function aboutLdJson(readable, headers, nSample, callback){
  var rs = readable.pipe(split(function(row){
    if(row) {
      return JSON.parse(row);
    }
  }));

  jsonLdContextInfer(rs, {nSample: nSample}, function(err, schema, scores){
    if(err) return callback(err);
    callback(null, jsonLdContextInfer.about(schema));
  });

};


function aboutCsvTsv(readable, headers, nSample, callback){
  var rs = readable.pipe(binaryCSV({json:true, separator: (headers['content-type'] === 'text/csv') ? ',': '\t'}));

  jsonLdContextInfer(rs, {nSample: nSample}, function(err, schema, scores){
    if(err) return callback(err);
    callback(null, jsonLdContextInfer.about(schema));
  });

};


function aboutXls(readable, headers, nSample, callback){

  readable.pipe(concat(function(data){

    var parser, workbook;
    if(headers['content-type'] === 'application/vnd.ms-excel'){
      parser = xls;
      workbook = parser.read(data.toString('binary'), {type: 'binary'});
    } else {
      parser = xlsx;
      workbook = parser.read(data, {type: 'binary'});
    }

    if(workbook.SheetNames.length>1){
      console.error('multiple sheets in a workbook only the first one will be considered to generate an about');
    }

    var sheet = workbook.Sheets[workbook.SheetNames[0]];

    try {
      var ldjson = parser.utils.sheet_to_row_object_array(sheet);
    } catch(e){
      return callback(e);
    }

    var rs = new stream.Readable({objectMode:true});

    var keys = Object.keys(ldjson[0]);
    for(var i=0, l = Math.min(ldjson.length, nSample); i<l; i++){
      var obj = {}; //push only hasOwnproperty
      var row = ldjson[i];

      keys.forEach(function(key){
        obj[key] = row[key];
      });
      rs.push(obj);
    }
    rs.push(null);

    jsonLdContextInfer(rs, {nSample: nSample}, function(err, schema, scores){
      if(err) return callback(err);
      callback(null, jsonLdContextInfer.about(schema));
    });

  }));

};

module.exports = about;
